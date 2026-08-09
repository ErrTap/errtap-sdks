# @errtap/react-native

React Native SDK for ErrTap — hooks the global `ErrorUtils` runtime for uncaught
JS errors without importing React Native internals. Repeated `init` calls are
idempotent. Production Hermes promise rejections are captured when the runtime
provides its rejection-tracker hook.

```bash
npm i @errtap/react-native
```

```ts
// App.tsx (or index entry — call once at startup)
import { init } from '@errtap/react-native';

init({
  dsn: process.env.EXPO_PUBLIC_ERRTAP_DSN!, // https://et_…@host
  environment: __DEV__ ? 'development' : 'production',
  release: '1.0.0',
});
```

Manual capture / logs:

```ts
import { captureException, logger } from '@errtap/react-native';

logger.info('checkout started');
try {
  await pay();
} catch (e) {
  captureException(e as Error);
  throw e;
}
```
