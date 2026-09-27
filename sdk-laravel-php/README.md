# errtap/laravel

Laravel SDK for [ErrTap](https://www.errtap.com). Reports exceptions and structured logs, flags slow queries and N+1 queries, and sends queue diagnostics (job lifecycles, queue depth and unique-lock scans) to the project's **Queues** page. No Composer dependencies.

- Package: [`errtap/laravel`](https://packagist.org/packages/errtap/laravel)
- Docs: [docs.errtap.com/platforms/laravel](https://docs.errtap.com/platforms/laravel)

## Install

```bash
composer require errtap/laravel
```

The service provider is auto-discovered. Add your DSN to `.env`:

```dotenv
ERRTAP_DSN=https://et_<key>@<host>/<project>
ERRTAP_RELEASE=1.4.3   # optional, used for release health and regression detection
```

Copy the DSN from **Project settings → Client keys**.

## Quick start

The provider initializes the client but doesn't hook the exception handler for you. Add one line.

**Laravel 11 and later**, in `bootstrap/app.php`:

```php
use Illuminate\Foundation\Configuration\Exceptions;

->withExceptions(function (Exceptions $exceptions) {
    $exceptions->reportable(fn (Throwable $e) => \ErrTap\ErrTap::captureException($e));
})
```

**Laravel 10 and earlier**, in `App\Exceptions\Handler::register()`:

```php
$this->reportable(fn (Throwable $e) => \ErrTap\ErrTap::captureException($e));
```

## Configuration

Settings are read through `config('errtap.*')`, so they keep working after `php artisan config:cache`. To edit the config file directly, publish it:

```bash
php artisan vendor:publish --tag=errtap-config
```

| Env variable | Config key | Default | Description |
| --- | --- | --- | --- |
| `ERRTAP_DSN` | `dsn` | none | URL DSN or bare `et_…` key. Without it the SDK stays off |
| `ERRTAP_ENDPOINT` | `endpoint` | derived from the DSN | Ingest URL override, e.g. `https://<host>/ingest/error`. Required for a bare key |
| `ERRTAP_ENV` | `environment` | `APP_ENV`, then `production` | Environment name |
| `ERRTAP_RELEASE` | `release` | none | Release identifier |
| `ERRTAP_DB_MONITOR` | `db_monitor` | `true` | Report slow queries and N+1 queries |
| `ERRTAP_SLOW_QUERY_MS` | `slow_query_ms` | `500` | Queries at or above this duration are reported |
| `ERRTAP_N1_THRESHOLD` | `n1_threshold` | `10` | Identical SQL run this many times in one request or job is reported as N+1 |
| `ERRTAP_QUEUE_MONITOR` | `queue_monitor` | `true` | Send queue diagnostics |
| `ERRTAP_QUEUE_SAMPLE_RATE` | `queue_sample_rate` | `1.0` | Share of successful jobs reported (0 to 1). Failures and timeouts are always reported |
| `ERRTAP_QUEUE_SNAPSHOT_SECONDS` | `queue_snapshot_seconds` | `10` | How often workers snapshot queue depth |
| `ERRTAP_QUEUES` | `queues` | none | Extra queues to snapshot besides the ones workers serve, e.g. `redis:emails,default` |
| `ERRTAP_QUEUE_CONTROL` | `queue_control` | `false` | Let the dashboard pause, resume and clear queues (see below) |
| `ERRTAP_QUEUE_CONTROL_TOKEN` | `queue_control_token` | none | Upload token used for queue control |

## Capturing errors

```php
use ErrTap\ErrTap;

try {
    $gateway->charge($order);
} catch (Throwable $e) {
    ErrTap::captureException($e, [
        'tags' => ['flow' => 'checkout'],
        'context' => ['orderId' => $order->id],
        'user' => ['id' => $user->id],
    ]);
}

ErrTap::captureMessage('payment fallback used', ['level' => 'warning']);
```

The second argument is merged into the event. Supported keys: `tags`, `context`, `user`, `level`, `fingerprint`, `url`, `release`, `environment`. Events carry `php` (the PHP version) and `sdk: laravel` in their context. Your `context` keys are merged over these, so a key of your own with the same name wins.

## Logs

```php
ErrTap::info('checkout started', ['orderId' => $order->id]);
ErrTap::warning('slow gateway', ['ms' => 2300]);
// also ErrTap::debug(), ErrTap::error(), ErrTap::log($level, $message, $data)
```

Logs appear on the project's **Logs** page with the request URI attached.

## Database monitoring

With `ERRTAP_DB_MONITOR` on, the SDK listens to `DB::listen`:

- A query at or above `ERRTAP_SLOW_QUERY_MS` is reported as a `SlowDbQuery` warning, grouped per SQL statement.
- The same SQL text run `ERRTAP_N1_THRESHOLD` or more times in one request (or one queued job) is reported as an `NPlusOneQuery` warning.

## Queue monitoring

Queue workers report to the project's **Queues** page with no extra setup:

- Each job's lifecycle (queued, started, released, processed, failed, timed out) with wait time, duration, CPU time and peak memory. Peak memory needs PHP 8.2+.
- The depth of each queue a worker serves (pending, delayed, running, oldest wait) and the first jobs in line. Line-up is shown for the Redis and database drivers.
- A scan of held `ShouldBeUnique` locks (Redis and database cache stores). Locks that no queued or running job explains are flagged as stuck.

Data is batched and sent from the worker loop every few seconds, never once per job. Queue telemetry does not count toward your event quota. If ErrTap is unreachable, workers back off instead of retrying on every loop.

### Queue control (opt-in)

With control enabled, the Queues page can pause, resume and clear a queue, move a waiting job to the front (Redis driver; delayed jobs can be run next), and release a unique-job lock that nothing holds any more. Workers poll for commands every few seconds, so ErrTap never connects into your network.

```dotenv
ERRTAP_QUEUE_CONTROL=true
ERRTAP_QUEUE_CONTROL_TOKEN=<upload-token>   # Project settings → Upload tokens
```

- The command channel authenticates with an upload token, never the public DSN. With control on, lock scans are sent over that channel too, and the dashboard only offers **Release** for locks from those scans.
- Pause and resume use `Queue::pause()`, which needs a Laravel version that has it. Clearing works on drivers that implement `ClearableQueue` (Redis, database, SQS, Beanstalkd).
- Only organization owners and admins can send commands, and every command is recorded in the audit log.

## Delivery behaviour

- During HTTP requests, events are held and sent after the response has gone out (on `terminating`), so a slow or unreachable ErrTap never delays your users. A shutdown hook also flushes after fatal errors.
- Console commands and queue workers send immediately.
- Each request has a 2-second connect and 3-second total timeout. Network errors, `408` and `5xx` are retried twice; one flush never holds a worker longer than 5 seconds.
- Other `4xx`, including `429`, count as a failed send and aren't retried. The SDK doesn't read `Retry-After` or pause later sends.
- A single request holds at most 50 pending events.
- Telemetry never throws into your application.

## Releases and source maps

Set `ERRTAP_RELEASE` in each deploy. To mark a deploy from CI, POST to `/ingest/release` with an upload token (needs a plan with release health). Regression detection compares releases you've registered this way; see [Releases](https://docs.errtap.com/concepts/releases):

```bash
curl -X POST https://<host>/ingest/release \
  -H "Authorization: Bearer $ERRTAP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.4.3","environment":"production"}'
```

For front-end assets built with Vite, use [`@errtap/browser`](../sdk-js-browser) and its source-map upload.

## Cron heartbeats

There is no heartbeat helper. Create a monitor under **Cron**, then ping its URL when a scheduled task succeeds:

```php
use Illuminate\Support\Facades\Http;

$schedule->command('invoices:generate')->daily()->onSuccess(
    fn () => Http::post(config('services.errtap.invoice_heartbeat_url'))
);
```

The token in the URL authenticates the ping.

## Troubleshooting

- **Nothing is reported.** Check `ERRTAP_DSN` is set, run `php artisan config:clear` after changing `.env`, and confirm the exception hook line is in place.
- **Bare key doesn't work.** Set `ERRTAP_ENDPOINT` as well, or use the full URL DSN.
- **Queues page is empty.** Diagnostics come from running workers (`php artisan queue:work`). Check `ERRTAP_QUEUE_MONITOR` isn't `false`.
- **Queue commands never run.** Set both `ERRTAP_QUEUE_CONTROL=true` and `ERRTAP_QUEUE_CONTROL_TOKEN`, then restart workers.
- **Too many N+1 warnings.** Raise `ERRTAP_N1_THRESHOLD` or set `ERRTAP_DB_MONITOR=false`.

## Requirements

- PHP 8.1 or later with the `curl` extension.
- Laravel with package auto-discovery. The exception hook differs between Laravel 11+ and 10 and earlier (see Quick start).

## Links

- [Laravel docs](https://docs.errtap.com/platforms/laravel)
- [Queue monitoring](https://docs.errtap.com/concepts/queues)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
