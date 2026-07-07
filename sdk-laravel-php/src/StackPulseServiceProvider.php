<?php

namespace StackPulse;

use Illuminate\Support\ServiceProvider;

/**
 * Auto-discovered by Laravel. Reads config from env and initializes the
 * client. It does NOT auto-register the exception hook — add one line to
 * bootstrap/app.php (Laravel 11+):
 *
 *   ->withExceptions(function ($exceptions) {
 *       $exceptions->reportable(fn (\Throwable $e) => \StackPulse\StackPulse::captureException($e));
 *   })
 *
 * or in App\Exceptions\Handler::register() (Laravel <=10):
 *
 *   $this->reportable(fn (\Throwable $e) => \StackPulse\StackPulse::captureException($e));
 */
class StackPulseServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $dsn = env('STACKPULSE_DSN');
        if (!$dsn) {
            return;
        }
        StackPulse::init([
            'dsn' => $dsn,
            'endpoint' => env('STACKPULSE_ENDPOINT', 'http://localhost:4000/ingest/error'),
            'environment' => env('STACKPULSE_ENV', env('APP_ENV', 'production')),
            'release' => env('STACKPULSE_RELEASE'),
        ]);
    }
}
