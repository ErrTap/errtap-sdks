<?php

namespace ErrTap;

use Illuminate\Support\ServiceProvider;

/**
 * Auto-discovered by Laravel. Reads config/errtap.php (env-backed, so it survives
 * `php artisan config:cache`) and initializes the
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
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/errtap.php', 'errtap');
    }

    public function boot(): void
    {
        $this->publishes([
            __DIR__ . '/../config/errtap.php' => $this->app->configPath('errtap.php'),
        ], 'errtap-config');

        $dsn = config('errtap.dsn');
        if (!$dsn) {
            return;
        }
        $opts = [
            'dsn' => $dsn,
            'environment' => config('errtap.environment', 'production'),
            'release' => config('errtap.release'),
            'slowQueryMs' => (float) config('errtap.slow_query_ms', 500),
            'n1Threshold' => (int) config('errtap.n1_threshold', 10),
        ];
        $endpoint = config('errtap.endpoint');
        if ($endpoint) {
            $opts['endpoint'] = $endpoint;
        } elseif (!str_contains($dsn, '@')) {
            // bare key without URL: keep previous default so existing .env still works
            $opts['endpoint'] = 'http://localhost:4000/ingest/error';
        }
        ErrTap::init($opts);

        // DB monitoring: slow queries + N+1 detection (ERRTAP_DB_MONITOR=false to disable)
        if (config('errtap.db_monitor', true) && class_exists(\Illuminate\Support\Facades\DB::class)) {
            \Illuminate\Support\Facades\DB::listen(function ($query) {
                ErrTap::recordQuery($query->sql, (float) $query->time, $query->connectionName ?? null);
            });
            $this->app->terminating(fn () => ErrTap::flushQueryStats());
            // A queue worker only terminates when it exits; count queries per job, or
            // counts pile up across every job it runs (memory growth, false N+1s).
            if (class_exists(\Illuminate\Queue\Events\JobProcessed::class)) {
                $this->app['events']->listen(
                    [\Illuminate\Queue\Events\JobProcessed::class, \Illuminate\Queue\Events\JobFailed::class],
                    fn () => ErrTap::flushQueryStats(),
                );
            }
        }

        // HTTP: hold events until the response is out. Console/queue workers have no
        // user waiting and may run for days, so they send immediately. Registered after
        // flushQueryStats (terminating callbacks run in order) so N+1 reports ride along.
        if (!$this->app->runningInConsole()) {
            ErrTap::deferSends(true);
            $this->app->terminating(fn () => ErrTap::flush());
            // backstop for fatals that end the request before `terminating` runs
            register_shutdown_function(fn () => ErrTap::flush());
        }
    }
}
