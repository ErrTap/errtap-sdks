# @errtap/next

Next.js helpers for ErrTap — client wraps `@errtap/browser`, server wraps `@errtap/node`.

```bash
npm i @errtap/next
```

```ts
// instrumentation.ts (server — Node only; Edge has no process.on)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.ERRTAP_DSN) return;
  const { init } = await import('@errtap/next/server');
  init({
    dsn: process.env.ERRTAP_DSN, // https://et_…@host
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  });
}

export async function onRequestError(error, request, context) {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.ERRTAP_DSN) return;
  const { onRequestError: captureRequestError } = await import('@errtap/next/server');
  await captureRequestError(error, request, context);
}
```

```ts
// instrumentation-client.ts (browser — Next 15.3+)
import { init } from '@errtap/next/client';

if (process.env.NEXT_PUBLIC_ERRTAP_DSN) {
  init({
    dsn: process.env.NEXT_PUBLIC_ERRTAP_DSN,
    environment: process.env.NODE_ENV,
    // Core Web Vitals report by default; `vitals: false` or `vitalsSampleRate: 0.1` to tune
  });
}
```

Manual capture / logs:

```ts
import { captureException, logger } from '@errtap/next/server';
// or '@/errtap/next/client' in Client Components
```
