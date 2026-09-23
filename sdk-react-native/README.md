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


#### Keep crash reports that happen offline

A fatal JS error ends a release build, so ErrTap holds React Native's crash handler
for up to 2 seconds while the report is sent. Pass a key-value store and a crash that
can't be sent in time (offline, flaky network) is saved and delivered on next launch:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

init({ dsn: process.env.EXPO_PUBLIC_ERRTAP_DSN!, release: '1.0.0', storage: AsyncStorage });
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
