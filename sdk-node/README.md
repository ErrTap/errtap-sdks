# @errtap/node

Node.js error tracking for [ErrTap](https://www.errtap.com) — captures uncaught exceptions, unhandled rejections, and structured logs.

```bash
npm i @errtap/node
```

```js
import { init } from '@errtap/node';

init({
  dsn: process.env.ERRTAP_DSN, // https://et_…@host, from your project's settings page
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
});
```

`init` registers `uncaughtException` / `unhandledRejection` handlers. After an uncaught exception or unhandled rejection it prints the error, reports it (waiting at most 2s), then exits with code 1 — the same outcome as Node without the SDK. `--unhandled-rejections=warn|none` is respected; pass `exitOnFatal: false` to keep the process alive. Manual capture and logs:

```js
import { captureException, captureMessage, logger } from '@errtap/node';

await logger.info('job started', { jobId });
try {
  await work();
} catch (e) {
  await captureException(e, { tags: { job: 'imports' } });
  throw e;
}
```

Using NestJS or Next.js? Prefer `@errtap/nestjs` / `@errtap/next`, which wrap this package.

Docs: https://docs.errtap.com
