# @errtap/browser

Browser SDK for [ErrTap](https://www.errtap.com). Captures uncaught errors and unhandled promise rejections, sends structured logs and user feedback, and reports Core Web Vitals from real visitors. No dependencies.

- Package: [`@errtap/browser`](https://www.npmjs.com/package/@errtap/browser) (current: 0.5.0)
- Docs: [docs.errtap.com/platforms/browser](https://docs.errtap.com/platforms/browser)
- Using Next.js? Install [`@errtap/next`](../sdk-next) instead; it wraps this package.

## Install

```bash
npm i @errtap/browser
```

## Quick start

Call `init` once, as early as possible in your app's entry file:

```js
import { init } from '@errtap/browser';

init({
  dsn: 'https://et_<key>@<host>/<project>',
  environment: 'production',
  release: '1.4.3',
});
```

Copy the DSN from **Project settings → Client keys** in the dashboard. The DSN is a write-only ingest key and is safe to ship in a browser bundle.

After `init`, the SDK listens for `window` `error` and `unhandledrejection` events and reports them. Calling `init` again updates the configuration without adding duplicate listeners.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dsn` | `string` | required | URL DSN (`https://et_<key>@<host>/<project>`), or a bare `et_…` key when `endpoint` is set |
| `endpoint` | `string` | derived from the DSN | Full error-ingest URL override, e.g. `https://<host>/ingest/error`. Only needed for a bare key or a proxy (see below) |
| `environment` | `string` | `'production'` | Environment name attached to every event, log and vital |
| `release` | `string` | none | Release identifier. Used for source-map lookup, release health and, once the release is registered, regression detection ([Releases](https://docs.errtap.com/concepts/releases)) |
| `tags` | `Record<string, unknown>` | none | Tags attached to every event and log |
| `vitals` | `boolean` | `true` | Report Core Web Vitals once per page view. Set `false` to turn it off |
| `vitalsSampleRate` | `number` | `1` | Fraction of page views (0 to 1) that report vitals |

If the DSN can't be parsed, the SDK becomes a no-op instead of throwing.

`endpoint` only sets where errors go. Logs and vitals always go to `/ingest/log` and `/ingest/vitals` on the endpoint's origin, so a path prefix such as `https://example.com/errtap/ingest/error` is ignored for them. Feedback is sent to the endpoint with `/ingest/error` swapped for `/ingest/feedback`; if your `endpoint` doesn't end in `/ingest/error`, `captureFeedback` sends nothing.

## Capturing errors

```js
import { captureException, captureMessage } from '@errtap/browser';

try {
  await checkout();
} catch (error) {
  captureException(error, {
    tags: { flow: 'checkout' },
    context: { cartId: 'cart_123' },
    user: { id: 'u_193', email: 'user@example.com' },
  });
}

captureMessage('payment fallback used', { level: 'warning' });
```

Both functions accept an optional second argument whose fields are merged into the event:

| Field | Type | Description |
| --- | --- | --- |
| `tags` | `Record<string, unknown>` | Merged over the `init` tags |
| `context` | `Record<string, unknown>` | Arbitrary extra data shown on the event |
| `user` | `{ id?, email?, … }` | Who hit the error. `id` or `email` drives the "users affected" count |
| `level` | `string` | `error` (default), `warning`, `info`, `fatal` |
| `fingerprint` | `string` | Custom grouping key. Events with the same key group into one issue |
| `release` / `environment` | `string` | Override the `init` value for this event |
| `url` | `string` | Defaults to the current page URL |

The SDK attaches the page URL and user agent to every event automatically. It does not keep global user or breadcrumb state, so pass dynamic context on each call.

`captureException` accepts anything that was thrown, including non-`Error` values.

## Logs

```js
import { logger } from '@errtap/browser';

logger.info('checkout started', { orderId: 'ord_1' });
logger.warn('slow response', { ms: 2300 });
```

Levels: `debug`, `info`, `warn` (alias `warning`), `error`. Logs appear on the project's **Logs** page with a live tail.

## User feedback

Ask users what they were doing when something broke. Feedback is linked to the last error the SDK sent unless you pass an `eventId`.

```js
import { captureException, captureFeedback, lastEventId } from '@errtap/browser';

try {
  await checkout();
} catch (error) {
  captureException(error);
  const eventId = lastEventId();
  // later, from your own feedback form:
  await captureFeedback({ message: 'The pay button did nothing', email: 'user@example.com', eventId });
}
```

| Field | Type | Description |
| --- | --- | --- |
| `message` | `string` | Required. What the user wrote (up to 5,000 characters) |
| `name` | `string` | Optional |
| `email` | `string` | Optional |
| `url` | `string` | Defaults to the current page |
| `eventId` | `string` | Error to link to. Defaults to `lastEventId()` |

Feedback shows on the issue page and in the project's **User feedback** list. It does not count toward your event quota.

## Web Vitals

With `vitals` on (the default), each page view reports five metrics measured with the browser's `PerformanceObserver`:

| Metric | Measures | Good at p75 |
| --- | --- | --- |
| LCP | Largest Contentful Paint (loading) | 2.5 s or less |
| INP | Interaction to Next Paint (responsiveness) | 200 ms or less |
| CLS | Cumulative Layout Shift (visual stability) | 0.1 or less |
| FCP | First Contentful Paint | 1.8 s or less |
| TTFB | Time to First Byte | 800 ms or less |

The values are sent as one request when the page is first hidden (tab switch, navigation or close). The page URL is sent without its query string or hash. Results appear on the project's **Performance** page.

Notes:

- One report per hard page load, attributed to the landing URL. Client-side (SPA) route changes are not reported as separate page views.
- Metrics the browser doesn't support are skipped; some non-Chromium browsers don't expose LCP or INP.
- Each vitals report counts as one event toward your monthly quota. Use `vitalsSampleRate` to sample on high-traffic sites, for example `vitalsSampleRate: 0.1`.

## Source maps and releases

Minified stack traces are de-minified when ErrTap has the source maps for the event's `release`.

1. Emit source maps from your bundler (Vite `build.sourcemap: true`, webpack `devtool: 'source-map'`).
2. After each build, upload the `.js.map` files under the same `release` you pass to `init`, then delete them from the deployed output.

```bash
curl -X POST https://<host>/ingest/sourcemaps \
  -H "Authorization: Bearer $ERRTAP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"release":"1.4.3","files":[{"filename":"app.min.js","map":"<contents of app.min.js.map>"}]}'
```

- `filename` is the basename of the minified `.js` file, not the `.map`.
- Up to 50 files and 10 MB per request.
- Uploads use an **upload token** (Project settings → Upload tokens), not the DSN. Keep it in CI secrets and never ship it to the browser.
- Source map and release uploads need a plan with release health.

To mark a deploy, `POST /ingest/release` with `{"version":"1.4.3","environment":"production"}` and the same upload token.

## Delivery behaviour

- Requests use `fetch` with `keepalive`, so reports sent during page unload still leave the browser.
- Each request carries an `Idempotency-Key`; retries are stored once.
- Network errors, timeouts and `5xx` are retried twice. Other `4xx` responses are not retried.
- On `429`, the SDK pauses that endpoint for the `Retry-After` period and drops new events meanwhile.
- Identical errors within 60 seconds are sent once, and each page sends at most 60 errors and 60 logs per minute, so a render loop can't burn your quota.
- Error messages longer than 2,000 characters are truncated by the SDK, and oversized payloads are trimmed to fit the server's field limits instead of being rejected. See [Limits](https://docs.errtap.com/api/limits).

## Troubleshooting

- **Nothing appears.** Ingest returns `202` before the event is processed. Check the DSN host is reachable from the browser and that the request to `/ingest/error` returns `202` in the network tab.
- **`401`.** The key is wrong or revoked. Copy a fresh DSN from Project settings → Client keys.
- **`429`.** You hit a rate limit, spike protection or the monthly quota. See [Limits](https://docs.errtap.com/api/limits).
- **Stack traces stay minified.** The event's `release` must exactly match the release the maps were uploaded under, and `filename` must match the script basename.
- **No vitals.** Vitals are sent when the page is hidden, so switch tabs or navigate away after the page loads. Check `vitals` is not `false` and `vitalsSampleRate` is above `0`.

## Requirements

- Any modern browser with `fetch`. Web Vitals need `PerformanceObserver`.
- ES module package (`"type": "module"`), with TypeScript definitions included.

## Links

- [Browser docs](https://docs.errtap.com/platforms/browser)
- [Performance and Web Vitals](https://docs.errtap.com/concepts/performance)
- [Ingest API](https://docs.errtap.com/api/ingest)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
