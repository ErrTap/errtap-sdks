# errtap/laravel

Zero-dependency ErrTap error tracking for Laravel.

## Install

```bash
composer require errtap/laravel
```

Set env vars:

```
ERRTAP_DSN=your-dsn-here
ERRTAP_ENDPOINT=https://your-errtap-host/ingest/error # only required for a bare-key DSN
ERRTAP_ENV=production
ERRTAP_RELEASE=v1.0.0   # optional, enables regression detection
```

These are read through `config('errtap.*')`, so they keep working after
`php artisan config:cache`. To customize, publish the config file:

```bash
php artisan vendor:publish --tag=errtap-config
```

## Hook it up (one line)

**Laravel 11+** — in `bootstrap/app.php`:

```php
->withExceptions(function (Illuminate\Foundation\Configuration\Exceptions $exceptions) {
    $exceptions->reportable(fn (Throwable $e) => ErrTap\ErrTap::captureException($e));
})
```

**Laravel ≤10** — in `App\Exceptions\Handler::register()`:

```php
$this->reportable(fn (Throwable $e) => ErrTap\ErrTap::captureException($e));
```

Manual capture anywhere:

```php
ErrTap\ErrTap::captureMessage('something noteworthy');
```

## Queue monitoring

Queue workers report to the project's **Queues** page with no extra setup. It shows:

- each job's lifecycle (queued → started → released/processed/failed/timed out) with its wait time, duration, CPU time and peak memory. Peak memory needs PHP 8.2+.
- the depth of each queue a worker serves (pending, delayed, running, oldest wait) and the first jobs in line. Line-up is shown for the Redis and database drivers.
- a scan of held `ShouldBeUnique` locks (Redis and database cache stores), with locks that no queued or running job explains flagged as stuck.

Data is batched and sent from the worker loop every few seconds, never once per job.

```
ERRTAP_QUEUE_MONITOR=true        # set false to turn it off
ERRTAP_QUEUE_SAMPLE_RATE=1.0     # share of successful jobs reported; failures always are
ERRTAP_QUEUE_SNAPSHOT_SECONDS=10
ERRTAP_QUEUES=redis:emails,low   # extra queues to snapshot besides the ones workers serve
```

### Queue control (opt-in)

Once enabled, the Queues page can **pause**, **resume** and **clear** a queue, **move a
waiting job to the front** (Redis driver; delayed jobs can be run next), and **release a
unique-job lock** that nothing is holding any more. Workers
check for commands every few seconds, so ErrTap never has to reach into your network.
The command channel authenticates with an upload token, never the public DSN:

```
ERRTAP_QUEUE_CONTROL=true
ERRTAP_QUEUE_CONTROL_TOKEN=etu_…   # Project settings → Upload tokens
```

With control on, the lock scan is sent over the upload-token channel too. The dashboard only
offers **Release** for locks from such a scan, because anyone holding the public DSN can post
telemetry.

Pause and resume use `Queue::pause()`, which needs a Laravel version that has it. Clearing works on any driver that implements
`ClearableQueue` (Redis, database, SQS, Beanstalkd). Only organization owners and
admins can send commands, and every command is recorded in the audit log.
