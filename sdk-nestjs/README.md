# @errtap/nestjs

NestJS SDK for [ErrTap](https://www.errtap.com). A module that initializes [`@errtap/node`](../sdk-node) and registers a global exception filter, so unhandled exceptions are reported and Nest still renders its normal error response.

- Package: [`@errtap/nestjs`](https://www.npmjs.com/package/@errtap/nestjs) (current: 0.4.1, depends on `@errtap/node` ^0.4.0)
- Docs: [docs.errtap.com/platforms/nestjs](https://docs.errtap.com/platforms/nestjs)

## Install

```bash
npm i @errtap/nestjs
```

## Quick start

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { ErrTapModule } from '@errtap/nestjs';

@Module({
  imports: [
    ErrTapModule.forRoot({
      dsn: process.env.ERRTAP_DSN!, // https://et_<key>@<host>/<project>
      environment: process.env.NODE_ENV,
      release: process.env.GIT_SHA,
    }),
  ],
})
export class AppModule {}
```

`forRoot` is global, so import it once in the root module. It works with both the Express and Fastify platforms.

## What gets reported

`ErrTapExceptionFilter` is registered as an `APP_FILTER`. For every exception that reaches it:

- `HttpException`s with a status below 500 (validation errors, `NotFoundException`, `UnauthorizedException`, …) are **not** reported.
- Everything else, including `5xx` `HttpException`s and plain errors, is reported. Non-`Error` values are wrapped in an `Error`.
- The filter then calls Nest's `BaseExceptionFilter`, so responses are unchanged.

The underlying Node SDK also reports uncaught exceptions and unhandled rejections outside the request cycle.

If you already have a global filter, you can extend `ErrTapExceptionFilter` instead:

```ts
import { ErrTapExceptionFilter } from '@errtap/nestjs';

export class AppFilter extends ErrTapExceptionFilter {}
```

## Configuration

`forRoot` takes the `@errtap/node` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dsn` | `string` | required | URL DSN, or a bare `et_…` key when `endpoint` is set |
| `endpoint` | `string` | derived from the DSN | Full ingest URL override |
| `environment` | `string` | `'production'` | Environment attached to every event and log |
| `release` | `string` | none | Release identifier for regression detection and release health |
| `tags` | `Record<string, unknown>` | none | Tags attached to every event and log |
| `exitOnFatal` | `boolean` | `true` | Exit with code 1 after reporting an uncaught exception. Nest registers no crash handler of its own, so the default keeps Node's crash-and-restart behaviour |

If `dsn` is empty or invalid, the SDK is a no-op, so you can leave it unset in local development.

## Capturing errors

Everything from `@errtap/node` is re-exported:

```ts
import { captureException, captureMessage } from '@errtap/nestjs';

try {
  await this.billing.charge(order);
} catch (e) {
  await captureException(e as Error, {
    context: { orderId: order.id },
    user: { id: req.user.id },
  });
  throw e;
}
```

Capture options (`tags`, `context`, `user`, `level`, `fingerprint`, `release`, `url`) are listed in the [Node README](../sdk-node#capturing-errors).

## Logs

```ts
import { logger } from '@errtap/nestjs';

logger.info('job started', { jobId });
```

Levels: `debug`, `info`, `warn` (alias `warning`), `error`.

## User feedback

`captureFeedback` and `lastEventId` are re-exported from `@errtap/node`. Feedback is usually collected in the browser; see [`@errtap/browser`](../sdk-js-browser#user-feedback).

## Releases

Set `release` to your deploy identifier and mark deploys from CI with `POST /ingest/release` and an upload token. See the [Node README](../sdk-node#releases-and-source-maps).

## Cron heartbeats

There is no heartbeat helper. POST the monitor's ping URL at the end of a successful `@Cron` job:

```ts
@Cron('0 3 * * *')
async nightly() {
  await this.reports.build();
  await fetch(process.env.NIGHTLY_HEARTBEAT_URL!, { method: 'POST' });
}
```

## Troubleshooting

- **4xx errors aren't showing up.** By design: only `5xx` and non-HTTP exceptions are reported. Capture others manually if you need them.
- **Errors handled by your own global filter are missing.** Only one filter handles each exception. If another global filter catches it first, extend `ErrTapExceptionFilter` in that filter, or call `captureException` from it.
- **Process exits after an uncaught error.** That's `exitOnFatal: true`. Set it to `false` if you handle restarts differently.

## Requirements

- `@nestjs/common` and `@nestjs/core` 10 or later (peer dependencies).
- Node.js 18 or later.

## Links

- [NestJS docs](https://docs.errtap.com/platforms/nestjs)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
