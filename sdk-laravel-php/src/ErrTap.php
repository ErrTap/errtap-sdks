<?php

namespace ErrTap;

use Throwable;

/**
 * Zero-dependency ErrTap client. Sends captured exceptions to the
 * /ingest/error endpoint with `Authorization: DSN <key>`, matching the
 * JS/Node SDK payload shape. Telemetry never throws into the host app.
 *
 * DSN may be a URL (`https://et_key@host`) or a bare key (requires endpoint).
 */
class ErrTap
{
    private static ?array $cfg = null;

    /** @var array<string,int> per-request duplicate-query counter for N+1 detection */
    private static array $queryCounts = [];

    /**
     * Events held until the response has gone out (see deferSends).
     * @var list<array{url:string,body:string}>
     */
    private static array $outbox = [];

    private static bool $defer = false;

    // bounded so an error storm in one request can't grow memory without limit
    private const OUTBOX_MAX = 50;

    // one flush never holds a worker longer than this, however many events fail
    private const FLUSH_BUDGET_SECONDS = 5.0;

    private const CONNECT_TIMEOUT_SECONDS = 2;

    private const REQUEST_TIMEOUT_SECONDS = 3;

    /**
     * Hold events and send them from flush(). The service provider turns this on for
     * HTTP requests and flushes on `terminating`, which under PHP-FPM runs after the
     * response is sent — so a slow or unreachable ErrTap never delays the user.
     */
    public static function deferSends(bool $defer): void
    {
        self::$defer = $defer;
    }

    /** Send everything held by deferSends(). Safe to call more than once. */
    public static function flush(): void
    {
        $pending = self::$outbox;
        self::$outbox = [];
        $deadline = microtime(true) + self::FLUSH_BUDGET_SECONDS;
        foreach ($pending as $event) {
            if (microtime(true) >= $deadline) {
                return; // drop the rest rather than hold the worker
            }
            self::deliver($event['url'], $event['body'], $deadline);
        }
    }

    /**
     * @return array{key:string,endpoint:string,logEndpoint:string}|null
     */
    public static function resolveDsn(string $dsn, ?string $endpointOverride = null): ?array
    {
        if ($dsn === '') {
            return null;
        }
        if (str_contains($dsn, '@')) {
            $parts = parse_url($dsn);
            if ($parts === false || empty($parts['user']) || empty($parts['host'])) {
                return null;
            }
            $key = rawurldecode($parts['user']);
            $scheme = $parts['scheme'] ?? 'https';
            $port = isset($parts['port']) ? ':' . $parts['port'] : '';
            $origin = $scheme . '://' . $parts['host'] . $port;
            $logOrigin = $origin;
            if ($endpointOverride) {
                $ep = parse_url($endpointOverride);
                if ($ep !== false && !empty($ep['scheme']) && !empty($ep['host'])) {
                    $epPort = isset($ep['port']) ? ':' . $ep['port'] : '';
                    $logOrigin = $ep['scheme'] . '://' . $ep['host'] . $epPort;
                }
            }
            return [
                'key' => $key,
                'endpoint' => $endpointOverride ?: ($origin . '/ingest/error'),
                'logEndpoint' => $logOrigin . '/ingest/log',
            ];
        }
        if (!$endpointOverride) {
            return null;
        }
        $origin = null;
        $ep = parse_url($endpointOverride);
        if ($ep !== false && !empty($ep['scheme']) && !empty($ep['host'])) {
            $port = isset($ep['port']) ? ':' . $ep['port'] : '';
            $origin = $ep['scheme'] . '://' . $ep['host'] . $port;
        }
        return [
            'key' => $dsn,
            'endpoint' => $endpointOverride,
            'logEndpoint' => $origin
                ? ($origin . '/ingest/log')
                : preg_replace('#/ingest/error/?$#', '/ingest/log', $endpointOverride),
        ];
    }

    public static function init(array $options): void
    {
        $dsn = $options['dsn'] ?? '';
        $endpoint = $options['endpoint'] ?? null;
        $resolved = self::resolveDsn($dsn, $endpoint);
        if (!$resolved) {
            self::$cfg = null;
            return;
        }
        self::$cfg = array_merge([
            'environment' => 'production',
            'slowQueryMs' => 500,
            'n1Threshold' => 10,
        ], $options, [
            'dsn' => $resolved['key'],
            'endpoint' => $resolved['endpoint'],
            'logEndpoint' => $resolved['logEndpoint'],
            'queueEndpoint' => preg_replace('#/ingest/log$#', '/ingest/queue', $resolved['logEndpoint']),
        ]);
    }

    public static function enabled(): bool
    {
        return self::$cfg !== null;
    }

    /** @return mixed a config value from init(), e.g. 'environment' */
    public static function option(string $key, $default = null)
    {
        return self::$cfg[$key] ?? $default;
    }

    /**
     * Queue telemetry batch (see QueueMonitor). Deferred like everything else during
     * an HTTP request; sent now from workers, where the decoded response is returned.
     */
    public static function postQueue(array $payload): ?array
    {
        $cfg = self::$cfg;
        if (!$cfg || empty($cfg['queueEndpoint'])) {
            return null;
        }
        $payload['environment'] = $cfg['environment'] ?? 'production';
        $body = json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        if ($body === false) {
            return null;
        }
        if (self::$defer) {
            if (count(self::$outbox) < self::OUTBOX_MAX) {
                self::$outbox[] = ['url' => $cfg['queueEndpoint'], 'body' => $body];
            }
            return null;
        }
        $response = self::deliver($cfg['queueEndpoint'], $body, microtime(true) + self::FLUSH_BUDGET_SECONDS);
        $decoded = $response === null ? null : json_decode($response, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * @param array $extra merged into the event payload; `fingerprint` overrides
     *                     server-side grouping, `tags`/`context` attach metadata
     */
    public static function captureException(Throwable $e, array $extra = []): void
    {
        self::sendError(array_merge([
            'message' => $e->getMessage() ?: get_class($e),
            'type' => (new \ReflectionClass($e))->getShortName(),
            'stacktrace' => $e->getTraceAsString(),
        ], $extra));
    }

    public static function captureMessage(string $message, array $extra = []): void
    {
        self::sendError(array_merge(['message' => $message, 'type' => 'Message'], $extra));
    }

    public static function log(string $level, string $message, array $data = []): void
    {
        $cfg = self::$cfg;
        if (!$cfg || empty($cfg['logEndpoint'])) {
            return;
        }
        self::postJson($cfg['logEndpoint'], [
            'level' => $level,
            'message' => mb_substr($message, 0, 8192),
            'environment' => $cfg['environment'] ?? 'production',
            'release' => $cfg['release'] ?? null,
            'tags' => $cfg['tags'] ?? null,
            'url' => $_SERVER['REQUEST_URI'] ?? null,
            'context' => array_merge(['php' => PHP_VERSION, 'sdk' => 'laravel'], $data),
        ]);
    }

    public static function debug(string $message, array $data = []): void
    {
        self::log('debug', $message, $data);
    }

    public static function info(string $message, array $data = []): void
    {
        self::log('info', $message, $data);
    }

    public static function warning(string $message, array $data = []): void
    {
        self::log('warning', $message, $data);
    }

    public static function error(string $message, array $data = []): void
    {
        self::log('error', $message, $data);
    }

    /**
     * Feed every executed query here (wired to DB::listen by the service
     * provider). Reports queries slower than `slowQueryMs` immediately and
     * counts duplicates for N+1 detection.
     */
    public static function recordQuery(string $sql, float $timeMs, ?string $connection = null): void
    {
        if (!self::$cfg) {
            return;
        }
        if ($timeMs >= (float) self::$cfg['slowQueryMs']) {
            self::sendError([
                'message' => $sql,
                'type' => 'SlowDbQuery',
                'level' => 'warning',
                'fingerprint' => 'slow-query:' . md5($sql),
                'tags' => ['time_ms' => round($timeMs), 'connection' => $connection],
                'url' => $_SERVER['REQUEST_URI'] ?? null,
            ]);
        }
        self::$queryCounts[$sql] = (self::$queryCounts[$sql] ?? 0) + 1;
    }

    /**
     * End-of-request flush (wired to app terminating). The same statement
     * running `n1Threshold`+ times in one request is reported as an N+1.
     * ponytail: naive count of identical SQL text — parameterized queries share text, which is exactly the N+1 shape
     */
    public static function flushQueryStats(): void
    {
        $counts = self::$queryCounts;
        self::$queryCounts = [];
        if (!self::$cfg) {
            return;
        }
        foreach ($counts as $sql => $n) {
            if ($n >= (int) self::$cfg['n1Threshold']) {
                self::sendError([
                    'message' => $sql,
                    'type' => 'NPlusOneQuery',
                    'level' => 'warning',
                    'fingerprint' => 'n-plus-one:' . md5($sql),
                    'tags' => ['count' => $n],
                    'url' => $_SERVER['REQUEST_URI'] ?? null,
                ]);
            }
        }
    }

    private static function sendError(array $payload): void
    {
        $cfg = self::$cfg;
        if (!$cfg || empty($cfg['dsn']) || empty($cfg['endpoint'])) {
            return;
        }

        self::postJson($cfg['endpoint'], array_merge([
            'environment' => $cfg['environment'] ?? 'production',
            'release' => $cfg['release'] ?? null,
            'tags' => $cfg['tags'] ?? null,
            'context' => ['php' => PHP_VERSION, 'sdk' => 'laravel'],
        ], $payload));
    }

    // Network errors, 408 and 5xx are worth retrying. 4xx aren't: 401 (revoked DSN),
    // 413 (too large) and 429 (rate-limited or over quota) fail the same way again.
    private const TRANSPORT_RETRIES = 2;

    private static function postJson(string $url, array $payload): void
    {
        if (!self::$cfg) {
            return;
        }
        $body = json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        if ($body === false) {
            return;
        }
        if (self::$defer) {
            if (count(self::$outbox) < self::OUTBOX_MAX) {
                self::$outbox[] = ['url' => $url, 'body' => $body];
            }
            return;
        }
        self::deliver($url, $body, microtime(true) + self::FLUSH_BUDGET_SECONDS);
    }

    /** @return string|null the response body once delivered, null if it never was */
    private static function deliver(string $url, string $body, float $deadline): ?string
    {
        $cfg = self::$cfg;
        if (!$cfg) {
            return null;
        }
        try {
            $idempotencyKey = bin2hex(random_bytes(16));
        } catch (Throwable $ignored) {
            $idempotencyKey = uniqid('', true);
        }
        for ($attempt = 0; $attempt <= self::TRANSPORT_RETRIES; $attempt++) {
            $response = null;
            try {
                $status = self::sendOnce($url, $body, $cfg['dsn'], $idempotencyKey, $response);
            } catch (Throwable $ignored) {
                $status = 0; // never crash the host app over telemetry
            }
            if ($status >= 200 && $status < 300) {
                return is_string($response) ? $response : '';
            }
            $retryable = $status === 0 || $status === 408 || $status >= 500;
            if (!$retryable) {
                return null;
            }
            $backoff = 0.2 * ($attempt + 1);
            if ($attempt >= self::TRANSPORT_RETRIES || microtime(true) + $backoff >= $deadline) {
                return null;
            }
            usleep((int) ($backoff * 1_000_000));
        }
        return null;
    }

    /** @return int HTTP status, or 0 on a network error */
    private static function sendOnce(string $url, string $body, string $dsn, string $idempotencyKey, &$response = null): int
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return 0;
        }
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: DSN ' . $dsn,
                'Idempotency-Key: ' . $idempotencyKey,
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
            CURLOPT_TIMEOUT => self::REQUEST_TIMEOUT_SECONDS,
        ]);
        $response = curl_exec($ch);
        $status = curl_errno($ch) !== 0 ? 0 : (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return $status;
    }
}
