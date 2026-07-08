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

    public static function init(array $options): void
    {
        self::$cfg = array_merge(['environment' => 'production'], $options);
    }

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
