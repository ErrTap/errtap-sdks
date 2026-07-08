<?php

namespace ErrTap;

use Illuminate\Support\ServiceProvider;

/**
 * Auto-discovered by Laravel. Reads config from env and initializes the
 * client. It does NOT auto-register the exception hook — add one line to
 * bootstrap/app.php (Laravel 11+):
 *
 *   ->withExceptions(function ($exceptions) {
 *       $exceptions->reportable(fn (\Throwable $e) => \ErrTap\ErrTap::captureException($e));
 *   })
 *
 * or in App\Exceptions\Handler::register() (Laravel <=10):
 *
 *   $this->reportable(fn (\Throwable $e) => \ErrTap\ErrTap::captureException($e));
 */
class ErrTapServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $dsn = env('ERRTAP_DSN');
        if (!$dsn) {
            return;
        }
        ErrTap::init([
            'dsn' => $dsn,
            'endpoint' => env('ERRTAP_ENDPOINT', 'http://localhost:4000/ingest/error'),
            'environment' => env('ERRTAP_ENV', env('APP_ENV', 'production')),
            'release' => env('ERRTAP_RELEASE'),
        ]);
    }
}
