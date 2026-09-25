# @errtap/react-native

React Native SDK for [ErrTap](https://www.errtap.com). Captures uncaught JavaScript errors in React Native and Expo apps, keeps fatal crash reports that couldn't be sent in time, and sends structured logs. Includes a source-map uploader. No dependencies.

- Package: [`@errtap/react-native`](https://www.npmjs.com/package/@errtap/react-native) (current: 0.4.1)
- Docs: [docs.errtap.com/platforms/react-native](https://docs.errtap.com/platforms/react-native)

## Install

```bash
npm i @errtap/react-native
# optional, for offline crash persistence
npm i @react-native-async-storage/async-storage
```

## Quick start

Call `init` once, as early as possible in your entry file:

```ts
// index.js or App.tsx
import { init } from '@errtap/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

init({
  dsn: process.env.EXPO_PUBLIC_ERRTAP_DSN!, // https://et_<key>@<host>/<project>
  environment: __DEV__ ? 'development' : 'production',
  release: '1.0.0',
  storage: AsyncStorage,
});
```

With Expo, expose the DSN through an `EXPO_PUBLIC_` variable. The DSN is a write-only key, so shipping it in the app binary is expected.

## What gets captured

- **Uncaught JS errors**, through React Native's global `ErrorUtils` handler. The SDK reports the error, then calls the previous handler, so the red box in development and the crash in release builds behave as before. Repeated `init` calls don't stack handlers.
- **Fatal errors in release builds.** React Native's handler ends the app, so the SDK holds it for up to 2 seconds while the report is sent. With `storage`, the report is saved first and re-sent on next launch if the app died before it went out. A report that did arrive is not stored twice.
- **Unhandled promise rejections**, in production builds on Hermes only, through Hermes' rejection tracker. Other runtimes are not patched.

Every event carries `platform: react-native` as a tag, and `os` / `osVersion` in its context. Events are tagged `fatal: true|false`; unhandled rejections are tagged `unhandledPromise: true`.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dsn` | `string` | required | URL DSN, or a bare `et_…` key when `endpoint` is set |
| `endpoint` | `string` | derived from the DSN | Full ingest URL override |
| `environment` | `string` | `'production'` | Environment attached to every event and log |
| `release` | `string` | none | App version. Must match the release of uploaded source maps |
| `tags` | `Record<string, unknown>` | none | Tags attached to every event and log |
| `storage` | `{ getItem, setItem, removeItem }` | none | Key-value store (sync or async) for fatal crash persistence, e.g. AsyncStorage |

If the DSN can't be parsed, the SDK becomes a no-op.

## Capturing errors

```ts
import { captureException, captureMessage } from '@errtap/react-native';

try {
  await pay();
} catch (e) {
  captureException(e, { tags: { screen: 'Checkout' }, user: { id: userId } });
}

captureMessage('offline mode entered', { level: 'warning' });
```

Both calls are fire-and-forget and never throw. The second argument accepts `tags`, `context`, `user`, `level`, `fingerprint`, `release` and `url`, as in the [browser SDK](../sdk-js-browser#capturing-errors).

## Logs and breadcrumbs

```ts
import { logger } from '@errtap/react-native';

logger.info('checkout opened', { items: 3 });
```

Levels: `debug`, `info`, `warn` (alias `warning`), `error`. Each log is sent to the **Logs** page and also kept as a breadcrumb; the last 20 breadcrumbs are attached to the next error's context.

## User feedback and Web Vitals

Not available in this SDK. User feedback can be sent from a backend with [`@errtap/node`](../sdk-node#user-feedback) or with `POST /ingest/feedback`.

## Source maps and releases

Release bundles are minified. Upload the bundle's source map under the same `release` you pass to `init`, once per platform:

```bash
# Android (iOS: --bundle-output main.jsbundle)
npx react-native bundle --platform android --dev false \
  --entry-file index.js \
  --bundle-output index.android.bundle \
  --sourcemap-output index.android.bundle.map

ERRTAP_AUTH_TOKEN=<upload-token> \
ERRTAP_DSN=https://et_<key>@<host>/<project> \
ERRTAP_RELEASE=1.0.0 \
  npx errtap-upload-sourcemaps --sourcemap index.android.bundle.map
```

| Flag / variable | Description |
| --- | --- |
| `--sourcemap <path>` | Required. Path to the source map |
| `--bundle <name>` | Filename the runtime stack references. Defaults to the source map name without `.map` |
| `ERRTAP_AUTH_TOKEN` | Upload token from Project settings → Upload tokens. Keep it in CI; never bundle it into the app |
| `ERRTAP_DSN` | Project DSN, used only to find the host |
| `ERRTAP_RELEASE` | Must equal the `release` passed to `init` |
| `ERRTAP_ENDPOINT` | Ingest origin, only for a bare-key DSN |

With **Hermes**, upload the composed map (the Metro map composed with the Hermes bytecode map, for example via `react-native/scripts/compose-source-maps.js`), or columns won't line up. The uploader doesn't delete the map; it's a build artifact, not part of the app.

## Cron heartbeats

Not applicable on devices. Use the backend SDKs or `POST /ingest/heartbeat/<token>` from your server jobs.

## Delivery behaviour

- Each request carries an `Idempotency-Key` and times out after 10 seconds.
- Non-fatal events are sent once, with no retry queue. Fatal events are persisted first when `storage` is set.
- Payloads over 256 KB are truncated to the essentials.

## Troubleshooting

- **Nothing in development.** Errors are captured in `__DEV__`, but promise rejections are only tracked in production Hermes builds.
- **Crashes missing in release builds.** Pass `storage` so reports survive a crash while offline; they're sent on the next launch.
- **Frames stay minified.** The `release` in `init` must match `ERRTAP_RELEASE`, and `--bundle` must match the file name in the stack (`index.android.bundle` or `main.jsbundle`). On Hermes, upload the composed map.

## Requirements

- React Native 0.72 or later (optional peer dependency); works with Expo.
- The uploader runs on Node.js 18 or later.

## Links

- [React Native docs](https://docs.errtap.com/platforms/react-native)
- [Issues](https://github.com/ErrTap/errtap-sdks/issues)

## License

MIT
