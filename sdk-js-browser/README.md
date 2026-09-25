# @errtap/browser

Browser error tracking for [ErrTap](https://www.errtap.com) — captures unhandled errors, promise rejections, structured logs, and Core Web Vitals.

```bash
npm i @errtap/browser
```

```js
import { init } from '@errtap/browser';

init({
  dsn: 'https://et_…@api.errtap.com', // from your project's settings page
  environment: 'production',
  release: import.meta.env?.VITE_GIT_SHA,
});
```

`init` registers `window.onerror` and `unhandledrejection` handlers. Manual capture and logs:

```js
import { captureException, captureMessage, logger } from '@errtap/browser';

logger.info('checkout started', { cartSize: 3 });
try {
  await checkout();
} catch (e) {
  captureException(e, { tags: { flow: 'checkout' } });
}
```

### Web vitals

`init` also measures LCP, INP, CLS, FCP and TTFB (no extra dependency) and sends them in one
request when the page is first hidden, to your project's Performance page. The URL is sent
without its query string or hash. Opt out or sample:

```js
init({ dsn, vitals: false });          // off
init({ dsn, vitalsSampleRate: 0.1 });  // 10% of page views
```

Docs: https://docs.errtap.com
