<?php

namespace ErrTap;

use Throwable;

/**
 * Queue diagnostics: job lifecycle events with per-job CPU/memory, periodic queue
 * depth snapshots and a scan of unique-job locks. Everything is batched and sent to
 * /ingest/queue from the worker loop (Looping event), never per job.
 *
 * Wired by ErrTapServiceProvider when ERRTAP_QUEUE_MONITOR is on. Every hook swallows
 * its own errors — diagnostics must never fail a job.
 */
class QueueMonitor
{
    /** @var list<array> lifecycle events waiting to be sent */
    private static array $events = [];

    /** @var array<string,array{wall:float,cpu:float}> jobId => start marks */
    private static array $running = [];

    /** @var array<string,true> "connection|queue" pairs this process has worked */
    private static array $seen = [];

    private static float $lastFlush = 0.0;

    private static float $lastLockScan = 0.0;

    // after a failed send, stop trying for a while so a down ErrTap can't stall workers
    private static float $backoffUntil = 0.0;

    private static float $pollBackoffUntil = 0.0;

    /** Dashboard commands a worker may run; nothing else is ever executed. */
    private const COMMANDS = ['PAUSE', 'RESUME', 'CLEAR', 'PROMOTE', 'RELEASE_LOCK'];

    // ponytail: move-to-front searches this many pending (and delayed) jobs — a job deeper in a longer backlog reports "not found"
    private const PROMOTE_SEARCH = 10000;

    /**
     * Moves one job, found by payload uuid, to the head of a Redis queue in one atomic
     * step. Laravel pushes with RPUSH and pops with LPOP, so LPUSH is "next". A delayed
     * job leaves the delayed set and gets the notify token every push leaves.
     * KEYS: queue, queue:delayed, queue:notify. ARGV: needle, search limit.
     */
    private const PROMOTE_LUA = <<<'LUA'
local needle, limit = ARGV[1], tonumber(ARGV[2])
local n = math.min(redis.call('llen', KEYS[1]), limit)
for start = 0, n - 1, 500 do
  local jobs = redis.call('lrange', KEYS[1], start, math.min(start + 500, n) - 1)
  for i, job in ipairs(jobs) do
    if string.find(job, needle, 1, true) then
      if start + i == 1 then return 'front' end
      redis.call('lrem', KEYS[1], 1, job)
      redis.call('lpush', KEYS[1], job)
      return 'pending'
    end
  end
end
for _, job in ipairs(redis.call('zrange', KEYS[2], 0, limit - 1)) do
  if string.find(job, needle, 1, true) then
    redis.call('zrem', KEYS[2], job)
    redis.call('lpush', KEYS[1], job)
    redis.call('rpush', KEYS[3], 1)
    return 'delayed'
  end
end
return 0
LUA;

    // one command poll per app every few seconds, however many workers run
    private const POLL_EVERY_SECONDS = 3;

    private const MAX_EVENTS = 500;

    private const FLUSH_EVERY_SECONDS = 5.0;

    private const BACKOFF_SECONDS = 60.0;

    private const PEEK_PENDING = 50;

    private const PEEK_DELAYED = 20;

    private const MAX_LOCKS = 500;

    // ponytail: SCAN pages per lock scan (1000 keys each) — a cache over 50k keys gets a partial scan
    private const LOCK_SCAN_PAGES = 50;

    private const UNIQUE_PREFIX = 'laravel_unique_job:';

    /** @param \Illuminate\Contracts\Foundation\Application $app */
    public static function register($app): void
    {
        $events = $app['events'];
        $on = function (string $class, callable $fn) use ($events) {
            if (class_exists($class)) {
                $events->listen($class, function ($event) use ($fn) {
                    try {
                        $fn($event);
                    } catch (Throwable $ignored) {
                    }
                });
            }
        };
        $q = 'Illuminate\\Queue\\Events\\';
        $on($q . 'JobQueued', fn ($e) => self::onQueued($e));
        $on($q . 'JobProcessing', fn ($e) => self::onStart($e->job));
        $on($q . 'JobProcessed', fn ($e) => self::onFinish('processed', $e->job));
        $on($q . 'JobReleasedAfterException', fn ($e) => self::onFinish('released', $e->job, $e->exception ?? null));
        $on($q . 'JobFailed', fn ($e) => self::onFinish('failed', $e->job, $e->exception ?? null));
        // the worker kills itself right after this event, so send now
        $on($q . 'JobTimedOut', function ($e) {
            self::onFinish('timed_out', $e->job);
            self::flush(true);
        });
        // must return null: a false return from a Looping listener stops the worker
        $on($q . 'Looping', function ($e) {
            self::tick((string) $e->connectionName, (string) $e->queue);
        });
        $on($q . 'WorkerStopping', fn () => self::flush(true));
    }

    public static function onQueued($event): void
    {
        if (!isset($event->payload) || !is_string($event->payload)) {
            return; // Laravel < 10.x: no payload on JobQueued, so nothing to correlate by
        }
        $payload = json_decode($event->payload, true);
        $jobId = is_array($payload) ? ($payload['uuid'] ?? null) : null;
        if (!$jobId) {
            return;
        }
        $uniqueKey = self::uniqueKey($event->job ?? null);
        if (!$uniqueKey && !self::sampled($jobId)) {
            return;
        }
        self::record([
            'type' => 'queued',
            'jobId' => $jobId,
            'name' => $payload['displayName'] ?? 'unknown',
            'connection' => (string) $event->connectionName,
            'queue' => self::queueName($event->queue ?? null, $event->connectionName),
            'attempt' => 0,
            'at' => microtime(true),
            'delaySeconds' => is_numeric($event->delay ?? null) ? (int) $event->delay : null,
            'uniqueKey' => $uniqueKey,
        ]);
    }

    /** @param \Illuminate\Contracts\Queue\Job $job */
    public static function onStart($job): void
    {
        $jobId = $job->uuid();
        if (!$jobId) {
            return;
        }
        self::$seen[$job->getConnectionName() . '|' . $job->getQueue()] = true;
        if (function_exists('memory_reset_peak_usage')) {
            memory_reset_peak_usage();
        }
        self::$running[$jobId] = ['wall' => microtime(true), 'cpu' => self::cpuSeconds()];
        if (self::sampled($jobId)) {
            self::record(self::base('processing', $job));
        }
    }

    /** @param \Illuminate\Contracts\Queue\Job $job */
    public static function onFinish(string $type, $job, ?Throwable $e = null): void
    {
        $jobId = $job->uuid();
        if (!$jobId) {
            return;
        }
        $start = self::$running[$jobId] ?? null;
        // a job that fails before it starts (max attempts) has no start marks
        if ($type !== 'failed' || $start) {
            unset(self::$running[$jobId]);
        }
        if (($type === 'processed' || $type === 'released') && !self::sampled($jobId)) {
            return;
        }
        $event = self::base($type, $job);
        if ($start) {
            $event['durationMs'] = round((microtime(true) - $start['wall']) * 1000, 2);
            $event['cpuMs'] = round((self::cpuSeconds() - $start['cpu']) * 1000, 2);
            // PHP < 8.2 can't reset the peak, so it would be the process peak, not the job's
            if (function_exists('memory_reset_peak_usage')) {
                $event['memoryBytes'] = memory_get_peak_usage();
            }
        }
        if ($e) {
            $event['exception'] = get_class($e);
            $event['error'] = mb_substr($e->getMessage(), 0, 1000);
        }
        self::record($event);
    }

    /** Worker loop hook: flush on a timer and snapshot the queues this worker serves. */
    public static function tick(string $connection, string $queues): void
    {
        foreach (explode(',', $queues) as $queue) {
            if ($queue !== '') {
                self::$seen[$connection . '|' . $queue] = true;
            }
        }
        if (microtime(true) - self::$lastFlush >= self::FLUSH_EVERY_SECONDS) {
            self::flush(true);
            self::pollCommands();
        }
    }

    /**
     * Queue control (ERRTAP_QUEUE_CONTROL): claim the dashboard's pending commands,
     * run them, and report back. Only the COMMANDS allowlist can ever run.
     */
    public static function pollCommands(): void
    {
        $token = config('errtap.queue_control_token');
        if (!config('errtap.queue_control', false) || !is_string($token) || $token === '') {
            return;
        }
        if (microtime(true) < self::$pollBackoffUntil) {
            return;
        }
        try {
            if (!app('cache')->add('errtap:queue-command-poll', 1, self::POLL_EVERY_SECONDS)) {
                return;
            }
        } catch (Throwable $ignored) {
            return;
        }
        $response = ErrTap::postQueue([
            'host' => self::agent()['host'] ?? 'unknown',
            'canPause' => method_exists(app('queue'), 'pause'),
        ], '/commands', $token);
        if ($response === null) {
            self::$pollBackoffUntil = microtime(true) + self::BACKOFF_SECONDS;
            return;
        }
        foreach ((array) ($response['commands'] ?? []) as $command) {
            if (!is_array($command) || !isset($command['id'])) {
                continue;
            }
            try {
                $ack = ['ok' => true, 'result' => self::execute($command)];
            } catch (Throwable $e) {
                $ack = ['ok' => false, 'error' => mb_substr($e->getMessage(), 0, 1000)];
            }
            ErrTap::postQueue($ack, '/commands/' . rawurlencode((string) $command['id']) . '/ack', $token);
        }
    }

    /** @return array<string,mixed> what happened, shown on the dashboard */
    public static function execute(array $command): array
    {
        $type = (string) ($command['type'] ?? '');
        $connection = (string) ($command['connection'] ?? '');
        $queue = (string) ($command['queue'] ?? '');
        if (!in_array($type, self::COMMANDS, true)) {
            throw new \RuntimeException("Unsupported command: $type");
        }
        $target = (string) ($command['target'] ?? '');
        if ($type === 'RELEASE_LOCK') {
            return self::releaseLock($target);
        }
        if ($queue === '' || !is_array(config("queue.connections.$connection"))) {
            throw new \RuntimeException("Unknown queue connection: $connection");
        }
        $manager = app('queue');
        switch ($type) {
            case 'PAUSE':
            case 'RESUME':
                $method = $type === 'PAUSE' ? 'pause' : 'resume';
                if (!method_exists($manager, $method)) {
                    throw new \RuntimeException('This Laravel version cannot pause queues (needs Queue::pause).');
                }
                $manager->$method($connection, $queue);
                return ['paused' => $type === 'PAUSE'];
            case 'CLEAR':
                $q = $manager->connection($connection);
                if (!$q instanceof \Illuminate\Contracts\Queue\ClearableQueue) {
                    throw new \RuntimeException('The ' . self::driver($q) . ' driver cannot be cleared.');
                }
                return ['cleared' => (int) $q->clear($queue)];
            case 'PROMOTE':
                return self::promote($manager->connection($connection), $queue, $target);
        }
        return [];
    }

    public static function promote($q, string $queue, string $jobId): array
    {
        if (!$q instanceof \Illuminate\Queue\RedisQueue) {
            throw new \RuntimeException('Only Redis queues can move a job to the front.');
        }
        if (!preg_match('/^[A-Za-z0-9-]{1,64}$/', $jobId)) {
            throw new \RuntimeException('Invalid job id.');
        }
        $key = $q->getQueue($queue);
        $moved = $q->getConnection()->eval(
            self::PROMOTE_LUA,
            3,
            $key,
            $key . ':delayed',
            $key . ':notify',
            '"uuid":"' . $jobId . '"',
            self::PROMOTE_SEARCH,
        );
        if (!is_string($moved)) {
            throw new \RuntimeException('That job is no longer waiting on the queue.');
        }
        return ['moved' => $moved];
    }

    public static function releaseLock(string $key): array
    {
        // only unique-job locks — never an arbitrary cache key
        if (!str_starts_with($key, self::UNIQUE_PREFIX) || strlen($key) > 500) {
            throw new \RuntimeException('Not a unique-job lock.');
        }
        $store = app('cache')->store();
        if (!$store->getStore() instanceof \Illuminate\Contracts\Cache\LockProvider) {
            throw new \RuntimeException('The cache store does not support locks.');
        }
        $store->lock($key)->forceRelease();
        return ['released' => true];
    }

    /** Send buffered events, plus a snapshot of every queue whose turn it is. */
    public static function flush(bool $withSnapshot = false): void
    {
        self::$lastFlush = microtime(true);
        if (microtime(true) < self::$backoffUntil) {
            return;
        }
        $payload = [];
        if (self::$events) {
            $payload['events'] = self::$events;
        }
        if ($withSnapshot) {
            $queues = self::snapshotQueues();
            if ($queues) {
                $payload['queues'] = $queues;
            }
            $locks = self::scanLocksIfDue();
            if ($locks !== null) {
                $payload['locks'] = $locks;
            }
        }
        if (!$payload) {
            return;
        }
        $payload['agent'] = self::agent();
        self::$events = [];
        $deferred = !app()->runningInConsole();
        $response = ErrTap::postQueue($payload);
        if ($response === null && !$deferred) {
            self::$backoffUntil = microtime(true) + self::BACKOFF_SECONDS;
        }
    }

    /** @return list<array> queue snapshots this process won the turn for */
    private static function snapshotQueues(): array
    {
        $out = [];
        $interval = max(5, (int) config('errtap.queue_snapshot_seconds', 10));
        foreach (self::queueTargets() as [$connection, $queue]) {
            try {
                // one worker per queue per interval, however many are running
                if (!app('cache')->add("errtap:queue-snapshot:$connection:$queue", 1, $interval)) {
                    continue;
                }
                $snap = self::snapshot($connection, $queue);
                if ($snap) {
                    $out[] = $snap;
                }
            } catch (Throwable $ignored) {
            }
        }
        return $out;
    }

    /** @return list<array{0:string,1:string}> */
    private static function queueTargets(): array
    {
        $targets = self::$seen;
        foreach ((array) config('errtap.queues', []) as $entry) {
            $entry = trim((string) $entry);
            if ($entry === '') {
                continue;
            }
            [$connection, $queue] = str_contains($entry, ':')
                ? explode(':', $entry, 2)
                : [(string) config('queue.default'), $entry];
            $targets[$connection . '|' . $queue] = true;
        }
        $pairs = [];
        foreach (array_keys($targets) as $key) {
            [$connection, $queue] = explode('|', $key, 2);
            if ($connection !== 'sync' && $connection !== 'null') {
                $pairs[] = [$connection, $queue];
            }
        }
        return $pairs;
    }

    public static function snapshot(string $connection, string $queue): ?array
    {
        $q = app('queue')->connection($connection);
        $snap = [
            'connection' => $connection,
            'queue' => $queue,
            'driver' => self::driver($q),
            'size' => (int) $q->size($queue),
        ];
        foreach (['pending' => 'pendingSize', 'delayed' => 'delayedSize', 'reserved' => 'reservedSize'] as $field => $method) {
            if (method_exists($q, $method)) {
                $snap[$field] = (int) $q->$method($queue);
            }
        }
        $manager = app('queue');
        if (method_exists($manager, 'isPaused')) {
            $snap['paused'] = (bool) $manager->isPaused($connection, $queue);
        }
        if (method_exists($q, 'creationTimeOfOldestPendingJob')) {
            $oldest = $q->creationTimeOfOldestPendingJob($queue);
            $snap['oldestAt'] = is_numeric($oldest) ? (int) $oldest : null;
        }
        $snap['jobs'] = self::peek($q, $connection, $queue);
        return $snap;
    }

    /** First jobs in line, read without reserving them. */
    private static function peek($q, string $connection, string $queue): array
    {
        $jobs = [];
        try {
            if ($q instanceof \Illuminate\Queue\RedisQueue) {
                $redis = $q->getConnection();
                $key = $q->getQueue($queue);
                foreach ((array) $redis->lrange($key, 0, self::PEEK_PENDING - 1) as $raw) {
                    $jobs[] = self::describe($raw, null);
                }
                $delayed = $redis->eval(
                    "return redis.call('zrange', KEYS[1], 0, ARGV[1], 'WITHSCORES')",
                    1,
                    $key . ':delayed',
                    self::PEEK_DELAYED - 1,
                );
                for ($i = 0; $i + 1 < count((array) $delayed); $i += 2) {
                    $jobs[] = self::describe($delayed[$i], (int) $delayed[$i + 1]);
                }
            } elseif ($q instanceof \Illuminate\Queue\DatabaseQueue) {
                $table = (string) config("queue.connections.$connection.table", 'jobs');
                $rows = $q->getDatabase()->table($table)
                    ->where('queue', $q->getQueue($queue))
                    ->whereNull('reserved_at')
                    ->orderBy('id')
                    ->limit(self::PEEK_PENDING)
                    ->get(['payload', 'available_at']);
                $now = time();
                foreach ($rows as $row) {
                    $at = (int) $row->available_at;
                    $jobs[] = self::describe($row->payload, $at > $now ? $at : null);
                }
            }
        } catch (Throwable $ignored) {
        }
        return array_values(array_filter($jobs));
    }

    private static function describe($raw, ?int $availableAt): ?array
    {
        $p = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($p) || empty($p['uuid'])) {
            return null;
        }
        return [
            'id' => $p['uuid'],
            'name' => $p['displayName'] ?? 'unknown',
            'attempts' => (int) ($p['attempts'] ?? 0),
            'createdAt' => isset($p['createdAt']) ? (int) $p['createdAt'] : null,
            'availableAt' => $availableAt,
        ];
    }

    /**
     * Unique-job locks currently held in the default cache store, at most once a
     * minute across all workers. Null when it isn't this process's turn.
     *
     * @return array{store:string,supported:bool,keys:list<array{key:string,ttlMs:int|null}>,truncated:bool}|null
     */
    private static function scanLocksIfDue(): ?array
    {
        if (microtime(true) - self::$lastLockScan < 60) {
            return null;
        }
        self::$lastLockScan = microtime(true);
        try {
            if (!app('cache')->add('errtap:queue-lock-scan', 1, 60)) {
                return null;
            }
            return self::scanLocks();
        } catch (Throwable $ignored) {
            return null;
        }
    }

    public static function scanLocks(): array
    {
        $storeName = (string) config('cache.default');
        $store = app('cache')->store($storeName)->getStore();
        $result = ['store' => $storeName, 'supported' => true, 'keys' => [], 'truncated' => false];
        if ($store instanceof \Illuminate\Cache\RedisStore) {
            $redis = $store->lockConnection();
            $cursor = '0';
            for ($page = 0; $page < self::LOCK_SCAN_PAGES; $page++) {
                // KEYS[1] gets the client's prefix applied; SCAN's pattern doesn't, so
                // the script builds the pattern from the prefixed key and returns it.
                $res = $redis->eval(
                    "local r = redis.call('scan', ARGV[1], 'match', KEYS[1] .. '*', 'count', 1000)\n"
                    . "local out = {r[1], KEYS[1]}\n"
                    . "for _, k in ipairs(r[2]) do table.insert(out, k); table.insert(out, redis.call('pttl', k)) end\n"
                    . 'return out',
                    1,
                    $store->getPrefix() . self::UNIQUE_PREFIX,
                    $cursor,
                );
                $cursor = (string) $res[0];
                $prefixLen = strlen((string) $res[1]);
                for ($i = 2; $i + 1 < count($res); $i += 2) {
                    $ttl = (int) $res[$i + 1];
                    $result['keys'][] = [
                        'key' => self::UNIQUE_PREFIX . substr((string) $res[$i], $prefixLen),
                        'ttlMs' => $ttl >= 0 ? $ttl : null,
                    ];
                }
                if ($cursor === '0' || count($result['keys']) >= self::MAX_LOCKS) {
                    break;
                }
            }
            $result['truncated'] = $cursor !== '0';
        } elseif ($store instanceof \Illuminate\Cache\DatabaseStore) {
            $prefix = $store->getPrefix() . self::UNIQUE_PREFIX;
            $table = (string) (config("cache.stores.$storeName.lock_table") ?: 'cache_locks');
            $db = method_exists($store, 'getLockConnection') ? $store->getLockConnection() : $store->getConnection();
            $rows = $db->table($table)
                ->where('key', 'like', str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $prefix) . '%')
                ->where('expiration', '>', time())
                ->limit(self::MAX_LOCKS + 1)
                ->get(['key', 'expiration']);
            foreach ($rows->take(self::MAX_LOCKS) as $row) {
                $result['keys'][] = [
                    'key' => self::UNIQUE_PREFIX . substr((string) $row->key, strlen($prefix)),
                    // "forever" locks are stored with a far-future expiration
                    'ttlMs' => $row->expiration - time() > 86400 * 365 * 5 ? null : ($row->expiration - time()) * 1000,
                ];
            }
            $result['truncated'] = $rows->count() > self::MAX_LOCKS;
        } else {
            $result['supported'] = false;
        }
        $result['keys'] = array_slice($result['keys'], 0, self::MAX_LOCKS);
        return $result;
    }

    private static function record(array $event): void
    {
        if (count(self::$events) >= self::MAX_EVENTS) {
            return;
        }
        self::$events[] = array_filter($event, fn ($v) => $v !== null);
        // web requests hold everything until `terminating`; workers send in batches
        if (count(self::$events) >= 200 && app()->runningInConsole()) {
            self::flush();
        }
    }

    /** @param \Illuminate\Contracts\Queue\Job $job */
    private static function base(string $type, $job): array
    {
        return [
            'type' => $type,
            'jobId' => $job->uuid(),
            'name' => $job->resolveName(),
            'connection' => (string) $job->getConnectionName(),
            'queue' => (string) $job->getQueue(),
            'attempt' => (int) $job->attempts(),
            'at' => microtime(true),
        ];
    }

    private static function uniqueKey($command): ?string
    {
        if (!is_object($command) || !$command instanceof \Illuminate\Contracts\Queue\ShouldBeUnique) {
            return null;
        }
        if (method_exists(\Illuminate\Bus\UniqueLock::class, 'getKey')) {
            return \Illuminate\Bus\UniqueLock::getKey($command);
        }
        $id = method_exists($command, 'uniqueId') ? $command->uniqueId() : ($command->uniqueId ?? '');
        return self::UNIQUE_PREFIX . get_class($command) . ':' . $id;
    }

    private static function queueName($queue, $connection): string
    {
        if (is_string($queue) && $queue !== '') {
            return $queue;
        }
        return (string) config("queue.connections.$connection.queue", 'default');
    }

    private static function driver($q): string
    {
        return match (true) {
            $q instanceof \Illuminate\Queue\RedisQueue => 'redis',
            $q instanceof \Illuminate\Queue\DatabaseQueue => 'database',
            $q instanceof \Illuminate\Queue\SqsQueue => 'sqs',
            $q instanceof \Illuminate\Queue\BeanstalkdQueue => 'beanstalkd',
            default => strtolower((new \ReflectionClass($q))->getShortName()),
        };
    }

    private static function agent(): array
    {
        return [
            'host' => gethostname() ?: null,
            'php' => PHP_VERSION,
            'laravel' => app()->version(),
        ];
    }

    /** Deterministic per job, so every event of a sampled job is kept together. */
    private static function sampled(string $jobId): bool
    {
        $rate = (float) config('errtap.queue_sample_rate', 1.0);
        return $rate >= 1.0 || (crc32($jobId) % 10000) < $rate * 10000;
    }

    private static function cpuSeconds(): float
    {
        $u = function_exists('getrusage') ? getrusage() : null;
        if (!$u) {
            return 0.0;
        }
        return $u['ru_utime.tv_sec'] + $u['ru_utime.tv_usec'] / 1e6
            + $u['ru_stime.tv_sec'] + $u['ru_stime.tv_usec'] / 1e6;
    }

    /** @internal test hook */
    public static function reset(): void
    {
        self::$events = [];
        self::$running = [];
        self::$seen = [];
        self::$lastFlush = 0.0;
        self::$lastLockScan = 0.0;
        self::$backoffUntil = 0.0;
        self::$pollBackoffUntil = 0.0;
    }

    /** @internal test hook */
    public static function pending(): array
    {
        return self::$events;
    }
}
