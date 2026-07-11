# @errtap/next

Next.js helpers for ErrTap — client wraps `@errtap/browser`, server wraps `@errtap/node`.

```bash
npm i @errtap/next
```

```ts
// instrumentation.ts (server)
import { init } from '@errtap/next/server';

export async function register() {
  init({
    dsn: process.env.ERRTAP_DSN!, // https://et_…@host
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  });
}
```

```ts
// instrumentation-client.ts (browser — Next 15.3+)
import { init } from '@errtap/next/client';

init({
  dsn: process.env.NEXT_PUBLIC_ERRTAP_DSN!,
  environment: process.env.NODE_ENV,
});
```

Manual capture / logs:

```ts
import { captureException, logger } from '@errtap/next/server';
// or '@/errtap/next/client' in Client Components
```
