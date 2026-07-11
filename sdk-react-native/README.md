# @errtap/react-native

React Native SDK for ErrTap — hooks `ErrorUtils` for uncaught JS errors.

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
