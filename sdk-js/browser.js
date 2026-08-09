import { configure, captureException, captureMessage, logger, resolveDsn } from './core.js';

export { captureException, captureMessage, logger, resolveDsn };

let listenersInstalled = false;

/**
 * @param {{ dsn: string, endpoint?: string, environment?: string, release?: string, tags?: object }} options
 */
export function init(options) {
  configure(
    options,
    () => ({
      url: typeof location !== 'undefined' ? location.href : undefined,
      context: { userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined },
    }),
    // ponytail: sendBeacon can't carry the Authorization header, so keepalive fetch is the send path
    { keepalive: true },
  );
  if (typeof window === 'undefined' || listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener('error', (e) => {
    if (e.error) captureException(e.error);
    else captureMessage(String(e.message || 'Unknown error'), { url: e.filename });
  });
  window.addEventListener('unhandledrejection', (e) => {
    e.reason instanceof Error
      ? captureException(e.reason)
      : captureMessage(`Unhandled rejection: ${String(e.reason)}`);
  });
}
