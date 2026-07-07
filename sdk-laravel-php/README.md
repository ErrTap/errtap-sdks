# @stackpulse/laravel

Zero-dependency StackPulse error tracking for Laravel.

## Install

```bash
composer require stackpulse/laravel
```

Set env vars:

```
STACKPULSE_DSN=your-dsn-here
STACKPULSE_ENDPOINT=https://your-stackpulse-host/ingest/error
STACKPULSE_RELEASE=v1.0.0   # optional, enables regression detection
```

## Hook it up (one line)

**Laravel 11+** — in `bootstrap/app.php`:

```php
->withExceptions(function (Illuminate\Foundation\Configuration\Exceptions $exceptions) {
    $exceptions->reportable(fn (Throwable $e) => StackPulse\StackPulse::captureException($e));
})
```

**Laravel ≤10** — in `App\Exceptions\Handler::register()`:

```php
$this->reportable(fn (Throwable $e) => StackPulse\StackPulse::captureException($e));
```

Manual capture anywhere:

```php
StackPulse\StackPulse::captureMessage('something noteworthy');
```
