# @errtap/laravel

Zero-dependency ErrTap error tracking for Laravel.

## Install

```bash
composer require errtap/laravel
```

Set env vars:

```
ERRTAP_DSN=your-dsn-here
ERRTAP_ENDPOINT=https://your-errtap-host/ingest/error
ERRTAP_RELEASE=v1.0.0   # optional, enables regression detection
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
