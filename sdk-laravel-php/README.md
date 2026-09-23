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
