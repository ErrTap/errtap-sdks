# ErrTap SDKs

Official SDKs for [ErrTap](https://www.errtap.com) — error tracking, uptime and cron monitoring, logs and alerts for startups.

| Package | Platform | Install | Docs |
|---|---|---|---|
| [`@errtap/browser`](https://www.npmjs.com/package/@errtap/browser) | Browser / any JS framework | `npm i @errtap/browser` | [Browser](https://docs.errtap.com/platforms/browser) |
| [`@errtap/node`](https://www.npmjs.com/package/@errtap/node) | Node.js | `npm i @errtap/node` | [Node.js](https://docs.errtap.com/platforms/nodejs) |
| [`@errtap/next`](https://www.npmjs.com/package/@errtap/next) | Next.js | `npm i @errtap/next` | [Next.js](https://docs.errtap.com/platforms/nextjs) |
| [`@errtap/nestjs`](https://www.npmjs.com/package/@errtap/nestjs) | NestJS | `npm i @errtap/nestjs` | [NestJS](https://docs.errtap.com/platforms/nestjs) |
| [`@errtap/react-native`](https://www.npmjs.com/package/@errtap/react-native) | React Native / Expo | `npm i @errtap/react-native` | [React Native](https://docs.errtap.com/platforms/react-native) |
| [`errtap/laravel`](https://packagist.org/packages/errtap/laravel) | Laravel (PHP) | `composer require errtap/laravel` | [Laravel](https://docs.errtap.com/platforms/laravel) |
| [`ErrTap`](https://www.nuget.org/packages/ErrTap) | ASP.NET Core | `dotnet add package ErrTap` | [.NET](https://docs.errtap.com/platforms/dotnet) |

Already on a Sentry SDK? Point it at your ErrTap DSN — see [Sentry SDKs](https://docs.errtap.com/platforms/sentry-sdks).

## Quick start

```js
import { init, captureException } from '@errtap/browser';

init({ dsn: 'https://et_<key>@api.errtap.com/<project>' });

try {
  risky();
} catch (error) {
  captureException(error);
}
```

Get a DSN by creating a project at [app.errtap.com](https://app.errtap.com).

## Layout

- `sdk-js/` — shared source for the browser and Node SDKs. `sdk-js-browser/index.js` and `sdk-node/index.js` are generated from it with `node sync.mjs`; edit `sdk-js/`, not the generated files.
- One folder per published package; each has its own `README.md`.
- `sdk-dotnet-tests/` — transport tests for the .NET SDK.

## Issues and contributions

Bug reports and feature requests are welcome in [Issues](https://github.com/ErrTap/errtap-sdks/issues). This repository is published automatically from ErrTap's main codebase, where the SDKs are tested against the ingest API — so pull requests can't be merged here directly, but we read every one and port the good ones.

Security issues: please email security@errtap.com instead of opening a public issue.

## License

[MIT](./LICENSE)
