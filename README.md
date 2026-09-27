# ErrTap SDKs

Official SDKs for [ErrTap](https://www.errtap.com): error tracking, logs, Web Vitals, uptime and cron monitoring, and alerts for startups.

| Package | Platform | Version | Install | Docs |
| --- | --- | --- | --- | --- |
| [`@errtap/browser`](./sdk-js-browser) | Browser, any JS framework | 0.5.0 | `npm i @errtap/browser` | [Browser](https://docs.errtap.com/platforms/browser) |
| [`@errtap/node`](./sdk-node) | Node.js 18+ (ESM); 20.19+ or 22.12+ from CommonJS | 0.4.1 | `npm i @errtap/node` | [Node.js](https://docs.errtap.com/platforms/nodejs) |
| [`@errtap/next`](./sdk-next) | Next.js 13+ (App Router) | 0.5.2 | `npm i @errtap/next` | [Next.js](https://docs.errtap.com/platforms/nextjs) |
| [`@errtap/nestjs`](./sdk-nestjs) | NestJS 10+ | 0.4.1 | `npm i @errtap/nestjs` | [NestJS](https://docs.errtap.com/platforms/nestjs) |
| [`@errtap/react-native`](./sdk-react-native) | React Native 0.72+, Expo | 0.4.1 | `npm i @errtap/react-native` | [React Native](https://docs.errtap.com/platforms/react-native) |
| [`errtap/laravel`](./sdk-laravel-php) | Laravel, PHP 8.1+ | see Packagist | `composer require errtap/laravel` | [Laravel](https://docs.errtap.com/platforms/laravel) |
| [`ErrTap`](./sdk-dotnet) | ASP.NET Core, .NET 8+ | 0.2.1 | `dotnet add package ErrTap` | [.NET](https://docs.errtap.com/platforms/dotnet) |

Already using a Sentry SDK? Point it at your ErrTap DSN. See [Sentry SDKs](https://docs.errtap.com/platforms/sentry-sdks).

## What each SDK covers

| | Browser | Node | Next | NestJS | React Native | Laravel | .NET |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Uncaught errors | yes | yes | yes (both sides) | yes (filter) | yes | via exception hook | yes (middleware) |
| Manual capture | yes | yes | yes | yes | yes | yes | yes |
| Structured logs | yes | yes | yes | yes | yes | yes | yes |
| User feedback | yes | yes | yes | yes | no | no | no |
| Web Vitals | yes | no | yes (client) | no | no | no | no |
| Source-map uploader | curl | curl | `errtap-upload-sourcemaps` | curl | `errtap-upload-sourcemaps` | n/a | n/a |
| Slow query / N+1 | no | no | no | no | no | yes | no |
| Queue diagnostics | no | no | no | no | no | yes | no |

Cron heartbeats are plain HTTP pings to a monitor URL and work from any language.

## Quick start

```js
import { init, captureException } from '@errtap/browser';

init({ dsn: 'https://et_<key>@<host>/<project>' });

try {
  risky();
} catch (error) {
  captureException(error);
}
```

Create a project at [app.errtap.com](https://app.errtap.com) and copy its DSN from **Project settings → Client keys**. The DSN is a write-only ingest key; it's safe in client bundles. Source-map uploads, release markers and Laravel queue control use a separate **upload token** (Project settings → Upload tokens), which is a secret for CI only.

## Shared behaviour

All SDKs follow these rules:

- **Never break the host app.** A missing or invalid DSN turns the SDK into a no-op, and send failures are swallowed.
- **Same DSN format.** `https://et_<key>@<host>/<project>`, or a bare `et_…` key together with an explicit `endpoint`.
- **Idempotent sends.** Every request carries an `Idempotency-Key`, so retries are stored once.
- **Don't retry into a rate limit.** No SDK retries a `429`. The browser, Node (and so Next.js and NestJS) and .NET SDKs also honour `Retry-After` and drop new events to that endpoint until it passes. Laravel and React Native treat a `429` as a failed send and don't pause; with `storage` set, React Native keeps a fatal crash it couldn't deliver and resends it on the next launch.
- **Asynchronous ingest.** The API answers `202` once an event is queued; issues appear a moment later.

## Layout

- `sdk-js/` is the shared source for the browser and Node SDKs. `sdk-js-browser/index.js` and `sdk-node/index.js` are generated from it with `node sync.mjs`; edit `sdk-js/`, not the generated files.
- One folder per published package; each has its own `README.md`.
- `sdk-dotnet-tests/` holds transport tests for the .NET SDK.
- Run the JS SDK tests with `npm run test:sdk` from the ErrTap monorepo root.

## Issues and contributions

Bug reports and feature requests are welcome in [Issues](https://github.com/ErrTap/errtap-sdks/issues). This repository is published automatically from ErrTap's main codebase, where the SDKs are tested against the ingest API, so pull requests can't be merged here directly. We read every one and port the good ones.

Security issues: please email security@errtap.com instead of opening a public issue.

## License

[MIT](./LICENSE)
