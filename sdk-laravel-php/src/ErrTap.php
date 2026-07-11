<?php

namespace ErrTap;

use Throwable;

/**
 * Zero-dependency ErrTap client. Sends captured exceptions to the
 * /ingest/error endpoint with `Authorization: DSN <key>`, matching the
 * JS/Node SDK payload shape. Telemetry never throws into the host app.
 */
class ErrTap
{
    private static ?array $cfg = null;

    /** @var array<string,int> per-request duplicate-query counter for N+1 detection */
    private static array $queryCounts = [];

    public static function init(array $options): void
    {
        self::$cfg = array_merge([
            'environment' => 'production',
            'slowQueryMs' => 500,
            'n1Threshold' => 10,
        ], $options);
    }

    /**
     * @param array $extra merged into the event payload; `fingerprint` overrides
     *                     server-side grouping, `tags`/`context` attach metadata
     */
    public static function captureException(Throwable $e, array $extra = []): void
    {
        self::send(array_merge([
            'message' => $e->getMessage() ?: get_class($e),
            'type' => (new \ReflectionClass($e))->getShortName(),
            'stacktrace' => $e->getTraceAsString(),
        ], $extra));
    }

    public static function captureMessage(string $message, array $extra = []): void
    {
        self::send(array_merge(['message' => $message, 'type' => 'Message'], $extra));
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
            self::send([
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
                self::send([
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

    private static function send(array $payload): void
    {
        $cfg = self::$cfg;
        if (!$cfg || empty($cfg['dsn']) || empty($cfg['endpoint'])) {
            return;
        }

        $body = json_encode(array_merge([
            'environment' => $cfg['environment'] ?? 'production',
            'release' => $cfg['release'] ?? null,
            'tags' => $cfg['tags'] ?? null,
            'context' => ['php' => PHP_VERSION, 'sdk' => 'laravel'],
        ], $payload));

        try {
            $ch = curl_init($cfg['endpoint']);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Authorization: DSN ' . $cfg['dsn'],
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 5,
            ]);
            curl_exec($ch);
            curl_close($ch);
        } catch (Throwable $ignored) {
            // never crash the host app over telemetry
        }
    }
}
