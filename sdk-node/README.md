# @errtap/node

Node.js SDK for [ErrTap](https://www.errtap.com). Captures uncaught exceptions and unhandled promise rejections, and sends handled errors, structured logs and user feedback. No dependencies.

- Package: [`@errtap/node`](https://www.npmjs.com/package/@errtap/node) (current: 0.4.1)
- Docs: [docs.errtap.com/platforms/nodejs](https://docs.errtap.com/platforms/nodejs)
- Framework wrappers built on this package: [`@errtap/nestjs`](../sdk-nestjs), [`@errtap/next`](../sdk-next) (server side)

## Install

```bash
npm i @errtap/node
```

## Quick start

Call `init` as early as possible, before other code that might throw:

```js
import { init } from '@errtap/node';

init({
  dsn: process.env.ERRTAP_DSN, // https://et_<key>@<host>/<project>
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.APP_VERSION,
});
```

Copy the DSN from **Project settings → Client keys**. Keep it in an environment variable rather than in source.

After `init`, the SDK registers `uncaughtException` and `unhandledRejection` handlers on `process`. Calling `init` again replaces them instead of stacking duplicates. On runtimes with a partial `process` (Edge, some workers) the handlers are skipped and manual capture still works.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dsn` | `string` | required | URL DSN (`https://et_<key>@<host>/<project>`), or a bare `et_…` key when `endpoint` is set |
| `endpoint` | `string` | derived from the DSN | Full ingest URL override, e.g. `https://<host>/ingest/error` |
| `environment` | `string` | `'production'` | Environment attached to every event and log |
| `release` | `string` | none | Release identifier. Used for release health and, once the release is registered, regression detection ([Releases](https://docs.errtap.com/concepts/releases)) |
| `tags` | `Record<string, unknown>` | none | Tags attached to every event and log |
| `exitOnFatal` | `boolean` | `true` | Exit with code 1 after reporting an uncaught exception (see below) |

If the DSN can't be parsed, the SDK becomes a no-op instead of throwing.

`endpoint` only sets where errors go. Logs always go to `/ingest/log` on the endpoint's origin, ignoring any path prefix, and `captureFeedback` sends nothing unless the endpoint ends in `/ingest/error`.

### Fatal errors

Registering an `uncaughtException` listener normally stops Node from crashing. To keep Node's default behaviour, with `exitOnFatal: true` the SDK prints the error, waits up to 2 seconds for the report to send, then calls `process.exit(1)`.

Unhandled rejections are treated the same way unless the process runs with `--unhandled-rejections=warn` or `none`, in which case they are reported and the process keeps running.

Set `exitOnFatal: false` when a framework owns the process lifecycle. `@errtap/next` does this for you.

## Capturing errors

```js
import { captureException, captureMessage } from '@errtap/node';

try {
  await syncInvoices();
} catch (err) {
  await captureException(err, {
    tags: { job: 'invoice-sync' },
    context: { invoiceId: 'inv_42' },
    user: { id: 'u_193' },
  });
}

captureMessage('stripe webhook skipped', { level: 'warning' });
```

Once the SDK is initialized, both functions return a promise that resolves when the send finishes (it never rejects). Before `init`, or when the DSN couldn't be parsed, they return `undefined`, so use `await` rather than `.then()`. The second argument is merged into the event:

| Field | Type | Description |
| --- | --- | --- |
| `tags` | `Record<string, unknown>` | Merged over the `init` tags |
| `context` | `Record<string, unknown>` | Arbitrary extra data |
| `user` | `{ id?, email?, … }` | `id` or `email` drives the "users affected" count |
| `level` | `string` | `error` (default), `warning`, `info`, `fatal` |
| `fingerprint` | `string` | Custom grouping key |
| `release` / `environment` | `string` | Override the `init` value for this event |
| `url` | `string` | Request URL or route |

The SDK adds the Node version and platform to every event. It does not keep global breadcrumbs or request context, so pass them on each call.

### Express

The package doesn't install middleware. Capture from your error handler:

```js
app.use((err, req, res, next) => {
  void captureException(err, { url: req.originalUrl, tags: { method: req.method } });
  next(err);
});
```

## Logs

```js
import { logger } from '@errtap/node';

logger.info('job started', { jobId: 'job_1' });
logger.error('payment provider timeout', { provider: 'stripe' });
```

Levels: `debug`, `info`, `warn` (alias `warning`), `error`. Logs appear on the project's **Logs** page.

## User feedback

```js
import { captureFeedback } from '@errtap/node';

await captureFeedback({
  message: 'Export never finished',
  email: 'user@example.com',
  eventId, // from lastEventId(), or omit to link the last error this process sent
});
```

`lastEventId()` returns the id of the most recent error sent. Feedback does not count toward your event quota.

## Releases and source maps

Set `release` to the same value you deploy, such as a git SHA. Mark deploys from CI with an upload token (Project settings → Upload tokens):

```bash
curl -X POST https://<host>/ingest/release \
  -H "Authorization: Bearer $ERRTAP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"'"$GIT_SHA"'","environment":"production"}'
```

If you bundle or minify server code, upload its source maps to `/ingest/sourcemaps` the same way as for the browser SDK. See [Source maps](https://docs.errtap.com/platforms/browser#source-maps-de-minify-stack-traces).

## Cron heartbeats

The SDK has no heartbeat helper. Create a monitor under **Cron** in the dashboard, then POST its ping URL when a job succeeds:

```js
await fetch(process.env.INVOICE_HEARTBEAT_URL, { method: 'POST' });
```

The token in the URL authenticates the ping; no DSN header is needed.

## Delivery behaviour

- Each request carries an `Idempotency-Key`; retries are stored once.
- Requests time out after 10 seconds. Network errors, timeouts and `5xx` are retried twice; other `4xx` are not.
- On `429`, the SDK pauses that endpoint for the `Retry-After` period and drops new events meanwhile.
- The `429` pause and the cap of 100 unfinished requests apply per endpoint, so a paused or backed-up log endpoint doesn't stop error delivery. There is no client-side per-minute budget; the server's per-project limits apply.
- Error messages longer than 2,000 characters are truncated by the SDK, and oversized payloads are trimmed to fit the server's field limits instead of being rejected. See [Limits](https://docs.errtap.com/api/limits).

## Troubleshooting

- **Nothing appears.** A `202` means the event was queued, not stored. Confirm the host in the DSN is reachable from the server.
- **`401`.** The key is wrong or revoked.
- **Process exits after an error.** That's `exitOnFatal: true`, matching Node's default crash behaviour. Set it to `false` if something else manages restarts.
- **Short-lived scripts lose events.** `await` the `captureException` call before the script exits.

## Requirements

- Node.js 18 or later (uses the global `fetch`) when you `import` it.
- ES module only, with TypeScript definitions included. There is no CommonJS build: loading it with `require()` needs Node.js 20.19+ or 22.12+, where `require(esm)` is enabled by default.

## Links

- [Node.js docs](https://docs.errtap.com/platforms/nodejs)
- [Ingest API](https://docs.errtap.com/api/ingest)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
