<?php

// Read through config(), never env() at runtime: after `php artisan config:cache`
// Laravel stops loading .env, so env() in a service provider returns null.
// Publish to customize: php artisan vendor:publish --tag=errtap-config
return [
    'dsn' => env('ERRTAP_DSN'),
    // optional when the DSN is a URL DSN (https://et_…@host)
    'endpoint' => env('ERRTAP_ENDPOINT'),
    'environment' => env('ERRTAP_ENV', env('APP_ENV', 'production')),
    'release' => env('ERRTAP_RELEASE'),
    // slow queries + N+1 detection
    'db_monitor' => (bool) env('ERRTAP_DB_MONITOR', true),
    'slow_query_ms' => (float) env('ERRTAP_SLOW_QUERY_MS', 500),
    'n1_threshold' => (int) env('ERRTAP_N1_THRESHOLD', 10),
];
