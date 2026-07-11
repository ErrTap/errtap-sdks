# @errtap/browser

Browser error tracking for [ErrTap](https://www.errtap.com) — captures unhandled errors, promise rejections, and structured logs.

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

Or drop it in a plain `<script type="module">` — no build step required.

Docs: https://docs.errtap.com
