# @errtap/next

Next.js SDK for [ErrTap](https://www.errtap.com). Reports errors from both sides of an App Router app: the browser (through [`@errtap/browser`](../sdk-js-browser)) and the Node.js server (through [`@errtap/node`](../sdk-node)). Includes a request-error hook, Core Web Vitals, and a source-map uploader.

- Package: [`@errtap/next`](https://www.npmjs.com/package/@errtap/next) (current: 0.5.2, depends on `@errtap/browser` ^0.5.0 and `@errtap/node` ^0.4.0)
- Docs: [docs.errtap.com/platforms/nextjs](https://docs.errtap.com/platforms/nextjs)

## Install

```bash
npm i @errtap/next
```

| Import | Wraps | Use in |
| --- | --- | --- |
| `@errtap/next/client` (also the package root) | `@errtap/browser` | `instrumentation-client.ts`, Client Components |
| `@errtap/next/server` | `@errtap/node` | `instrumentation.ts`, Server Components, Route Handlers, Server Actions |

## Quick start

### Server: `instrumentation.ts`

Next calls `register()` for both the Node.js and Edge runtimes. Edge has no `process.on`, so initialize only on Node and load the server SDK with a dynamic import:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.ERRTAP_DSN) return;
  const { init } = await import('@errtap/next/server');
  init({
    dsn: process.env.ERRTAP_DSN, // https://et_<key>@<host>/<project>
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  });
}

export async function onRequestError(error: unknown, request: any, context: any) {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.ERRTAP_DSN) return;
  const { onRequestError } = await import('@errtap/next/server');
  await onRequestError(error, request, context);
}
```

`onRequestError` reports errors thrown while rendering Server Components, in Route Handlers and in Server Actions. It records the request path and method plus Next's route context (`routerKind`, `routePath`, `routeType`, `renderSource`, `renderType`, `revalidateReason`). Request headers are never included, because they can carry credentials.

The server `init` defaults `exitOnFatal` to `false` so Next keeps control of the process.

### Browser: `instrumentation-client.ts`

Requires Next.js 15.3 or later. The file runs before the app hydrates:

```ts
// instrumentation-client.ts
import { init } from '@errtap/next/client';

if (process.env.NEXT_PUBLIC_ERRTAP_DSN) {
  init({
    dsn: process.env.NEXT_PUBLIC_ERRTAP_DSN,
    environment: process.env.NODE_ENV,
    // must match the release the source maps are uploaded under
    release: process.env.NEXT_PUBLIC_ERRTAP_RELEASE ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  });
}
```

On Next.js versions before 15.3, call the same `init` from a Client Component rendered in your root layout.

## Configuration

Both `init` functions take the options of the package they wrap.

| Option | Type | Default | Side | Description |
| --- | --- | --- | --- | --- |
| `dsn` | `string` | required | both | URL DSN, or a bare `et_…` key when `endpoint` is set |
| `endpoint` | `string` | derived from the DSN | both | Full ingest URL override |
| `environment` | `string` | `'production'` | both | Environment name |
| `release` | `string` | none | both | Release identifier; must match uploaded source maps |
| `tags` | `Record<string, unknown>` | none | both | Tags attached to every event and log |
| `vitals` | `boolean` | `true` | client | Report Core Web Vitals once per page view |
| `vitalsSampleRate` | `number` | `1` | client | Fraction of page views (0 to 1) that report vitals |
| `exitOnFatal` | `boolean` | `false` | server | Exit after reporting an uncaught exception |

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `ERRTAP_DSN` | server, build | DSN for the Node SDK; also tells the uploader which host to use |
| `NEXT_PUBLIC_ERRTAP_DSN` | browser | DSN for the browser SDK (same or a separate project) |
| `NEXT_PUBLIC_ERRTAP_RELEASE` | browser, build | Release tag shared by browser events and uploaded source maps |
| `ERRTAP_AUTH_TOKEN` | build only | Upload token for source maps. A secret: never prefix it with `NEXT_PUBLIC_` |

The DSN is a write-only key, so exposing it through `NEXT_PUBLIC_` is expected. Keep real values in `.env.local` or your host's environment settings.

## Capturing errors

Import from the side you're on:

```ts
import { captureException, captureMessage, logger } from '@errtap/next/server';
// or '@errtap/next/client' in Client Components

try {
  await chargeCard();
} catch (err) {
  await captureException(err as Error, { tags: { flow: 'checkout' }, user: { id: userId } });
  throw err;
}
```

Both sides export `init`, `captureException`, `captureMessage`, `captureFeedback`, `lastEventId`, `logger` and `resolveDsn`. The server also exports `onRequestError`. See the [browser](../sdk-js-browser#capturing-errors) and [Node](../sdk-node#capturing-errors) READMEs for the capture options.

## Logs

```ts
logger.info('checkout started', { cartId });
```

Levels: `debug`, `info`, `warn` (alias `warning`), `error`.

## User feedback

From a Client Component, after an error:

```ts
import { captureFeedback } from '@errtap/next/client';

await captureFeedback({ message: 'Checkout froze', email });
```

Feedback links to the last error the browser SDK sent unless you pass `eventId`.

## Web Vitals

The client `init` reports LCP, INP, CLS, FCP and TTFB once per page load, when the page is first hidden. Results appear on the project's **Performance** page, ranked by page. Client-side route changes are not reported as separate page views.

```ts
init({ dsn, vitals: false });          // off
init({ dsn, vitalsSampleRate: 0.25 }); // 25% of page loads
```

Each vitals report counts as one event toward your monthly quota.

## Source maps and releases

Production browser bundles are minified. ErrTap de-minifies stack frames at ingest when three things line up:

1. **The build emits source maps:**

   ```js
   // next.config.mjs
   export default { productionBrowserSourceMaps: true };
   ```

2. **The maps are uploaded after the build.** The package ships `errtap-upload-sourcemaps`, which uploads every `.js.map` under `.next/static` and then deletes them so your source isn't served publicly:

   ```json
   {
     "scripts": {
       "build": "next build",
       "postbuild": "errtap-upload-sourcemaps"
     }
   }
   ```

   Pass a different build directory as the first argument if you changed `distDir`.

3. **Events and maps share a release.** The uploader reads the release from `ERRTAP_RELEASE`, then `NEXT_PUBLIC_ERRTAP_RELEASE`, then `VERCEL_GIT_COMMIT_SHA`. Give the client `init` the same value.

The uploader also reads `ERRTAP_DSN` or `NEXT_PUBLIC_ERRTAP_DSN` (to find the host), `ERRTAP_AUTH_TOKEN` (the upload token) and, for a bare-key DSN only, `ERRTAP_ENDPOINT`. If the token, DSN or release is missing, it still deletes the maps and logs that the upload was skipped, so source is never published by accident.

Create the upload token under **Project settings → Upload tokens**. Source map uploads need a plan with release health.

## Cron heartbeats

There is no heartbeat helper. POST a monitor's ping URL from your scheduled Route Handler or job when it succeeds:

```ts
await fetch(process.env.NIGHTLY_HEARTBEAT_URL!, { method: 'POST' });
```

## Troubleshooting

- **Server errors missing.** Check `instrumentation.ts` is at the project root (or in `src/`) and that `ERRTAP_DSN` is set for the server runtime, not only at build time.
- **Browser errors missing.** `NEXT_PUBLIC_` variables are inlined at build time; rebuild after changing them.
- **Edge errors.** The Edge runtime is skipped by the snippet above. Capture manually with the client SDK or move the route to the Node.js runtime.
- **Frames stay minified.** Look for the uploader's log line in the build output. The client `release` must equal the uploaded release exactly.
- **`[errtap] no .js.map files`.** `productionBrowserSourceMaps` is off, or the build directory isn't `.next`.

## Requirements

- Next.js 13 or later (peer dependency); `instrumentation-client.ts` needs 15.3+.
- Node.js 18 or later for the server SDK and the uploader.

## Links

- [Next.js docs](https://docs.errtap.com/platforms/nextjs)
- [Performance and Web Vitals](https://docs.errtap.com/concepts/performance)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
