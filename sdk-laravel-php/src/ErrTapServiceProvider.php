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
        // ERRTAP_ENDPOINT is optional when ERRTAP_DSN is a URL DSN (https://et_…@host)
        $opts = [
            'dsn' => $dsn,
            'environment' => env('ERRTAP_ENV', env('APP_ENV', 'production')),
            'release' => env('ERRTAP_RELEASE'),
            'slowQueryMs' => (float) env('ERRTAP_SLOW_QUERY_MS', 500),
            'n1Threshold' => (int) env('ERRTAP_N1_THRESHOLD', 10),
        ];
        $endpoint = env('ERRTAP_ENDPOINT');
        if ($endpoint) {
            $opts['endpoint'] = $endpoint;
        } elseif (!str_contains($dsn, '@')) {
            // bare key without URL: keep previous default so existing .env still works
            $opts['endpoint'] = 'http://localhost:4000/ingest/error';
        }
        ErrTap::init($opts);

        // DB monitoring: slow queries + N+1 detection (ERRTAP_DB_MONITOR=false to disable)
        if (env('ERRTAP_DB_MONITOR', true) && class_exists(\Illuminate\Support\Facades\DB::class)) {
            \Illuminate\Support\Facades\DB::listen(function ($query) {
                ErrTap::recordQuery($query->sql, (float) $query->time, $query->connectionName ?? null);
            });
            $this->app->terminating(fn () => ErrTap::flushQueryStats());
        }
    }
}
