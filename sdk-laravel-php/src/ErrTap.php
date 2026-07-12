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

    /** @var list<array{level:string,message:string,data?:mixed,ts:int}> */
    private static array $breadcrumbs = [];

    private const BREADCRUMB_MAX = 20;

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
        ]);
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
        self::pushBreadcrumb($level, $message, $data ?: null);
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

    private static function pushBreadcrumb(string $level, string $message, mixed $data): void
    {
        self::$breadcrumbs[] = [
            'level' => $level,
            'message' => $message,
            'data' => $data,
            'ts' => (int) round(microtime(true) * 1000),
        ];
        if (count(self::$breadcrumbs) > self::BREADCRUMB_MAX) {
            array_shift(self::$breadcrumbs);
        }
    }

    private static function sendError(array $payload): void
    {
        $cfg = self::$cfg;
        if (!$cfg || empty($cfg['dsn']) || empty($cfg['endpoint'])) {
            return;
        }

        if (self::$breadcrumbs) {
            $existing = is_array($payload['context'] ?? null) ? $payload['context'] : [];
            $payload['context'] = array_merge($existing, ['breadcrumbs' => self::$breadcrumbs]);
        }

        self::postJson($cfg['endpoint'], array_merge([
            'environment' => $cfg['environment'] ?? 'production',
            'release' => $cfg['release'] ?? null,
            'tags' => $cfg['tags'] ?? null,
            'context' => ['php' => PHP_VERSION, 'sdk' => 'laravel'],
        ], $payload));
    }

    // matches sdk-node/sdk-js-browser's retry count, so a transient network blip
    // doesn't silently drop the event in PHP only.
    private const TRANSPORT_RETRIES = 2;

    private static function postJson(string $url, array $payload): void
    {
        $cfg = self::$cfg;
        if (!$cfg) {
            return;
        }
        $body = json_encode($payload);
        for ($attempt = 0; $attempt <= self::TRANSPORT_RETRIES; $attempt++) {
            try {
                if (self::sendOnce($url, $body, $cfg['dsn'])) {
                    return;
                }
            } catch (Throwable $ignored) {
                // never crash the host app over telemetry
            }
            if ($attempt < self::TRANSPORT_RETRIES) {
                usleep(200_000 * ($attempt + 1));
            }
        }
    }

    private static function sendOnce(string $url, string $body, string $dsn): bool
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return false;
        }
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: DSN ' . $dsn,
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
        ]);
        curl_exec($ch);
        $failed = curl_errno($ch) !== 0;
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return !$failed && $status >= 200 && $status < 300;
    }
}
