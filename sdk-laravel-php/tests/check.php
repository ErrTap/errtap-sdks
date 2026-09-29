<?php
// Runnable check for ErrTap payload shaping; no framework needed: php tests/check.php
require __DIR__ . '/../src/ErrTap.php';

use ErrTap\ErrTap;

function check(bool $ok, string $what): void
{
    if (!$ok) {
        fwrite(STDERR, "FAIL: $what\n");
        exit(1);
    }
}

function sent(): array
{
    $outbox = new ReflectionProperty(ErrTap::class, 'outbox');
    $events = array_map(fn ($e) => json_decode($e['body'], true), $outbox->getValue());
    $outbox->setValue(null, []);
    return $events;
}

ErrTap::init(['dsn' => 'https://et_key@example.test/1', 'tags' => ['team' => 'core'], 'slowQueryMs' => 0]);
ErrTap::deferSends(true);

ErrTap::captureMessage(str_repeat('m', 10000), ['context' => ['orderId' => 7, 'sdk' => 'mine'], 'tags' => ['route' => 'x']]);
[$event] = sent();
check(mb_strlen($event['message']) === 2000, 'message cut to ErrorEventDto 2000');
check($event['context']['php'] === PHP_VERSION && $event['context']['orderId'] === 7, 'SDK markers survive caller context');
check($event['context']['sdk'] === 'mine', 'caller context wins on conflicts');
check($event['tags'] === ['route' => 'x', 'team' => 'core'], 'configured tags survive per-event tags');

$sql = 'select * from t where id in (' . str_repeat('?,', 3000) . '?)';
ErrTap::recordQuery($sql, 10.0);
[$slow] = sent();
check(mb_strlen($slow['message']) === 2000 && $slow['type'] === 'SlowDbQuery', 'slow query SQL message cut to 2000');
check(str_starts_with($sql, $slow['context']['sql']) && isset($slow['context']['php']), 'long SQL kept in context with markers');

ErrTap::captureMessage('big', ['context' => ['blob' => str_repeat('c', 40000)]]);
[$big] = sent();
check($big['context'] === ['php' => PHP_VERSION, 'sdk' => 'laravel'], 'context over 32KB falls back to markers');

ErrTap::info('log', ['blob' => str_repeat('c', 40000)]);
[$log] = sent();
check($log['context'] === ['php' => PHP_VERSION, 'sdk' => 'laravel'], 'log context over 32KB falls back to markers');

echo "ok\n";
