# @errtap/nestjs

NestJS module for ErrTap — wraps `@errtap/node` and reports unhandled exceptions via a global filter.

```bash
npm i @errtap/nestjs
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { ErrTapModule } from '@errtap/nestjs';

@Module({
  imports: [
    ErrTapModule.forRoot({
      dsn: process.env.ERRTAP_DSN!, // https://et_…@host
      environment: process.env.NODE_ENV,
      release: process.env.GIT_SHA,
    }),
  ],
})
export class AppModule {}
```

Manual capture / logs:

```ts
import { captureException, logger } from '@errtap/nestjs';

logger.info('job started', { jobId });
try {
  await work();
} catch (e) {
  await captureException(e as Error);
  throw e;
}
```

`exitOnFatal` defaults to `false` so Nest keeps owning process lifecycle.
