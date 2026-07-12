import { configure, captureException, captureMessage, logger, resolveDsn } from './core.js';

export { captureException, captureMessage, logger, resolveDsn };

// re-init (e.g. in tests or hot-reload) would otherwise stack a duplicate pair of
// these listeners on `process` every call; drop the prior pair first.
let uncaughtHandler = null;
let rejectionHandler = null;

/**
 * @param {{ dsn: string, endpoint?: string, environment?: string, release?: string, tags?: object, exitOnFatal?: boolean }} options
 */
export function init(options = {}) {
  const exitOnFatal = options.exitOnFatal !== false;
  configure(options, () => ({ context: { node: process.version, platform: process.platform } }));

  // Edge / workers expose a partial `process` without EventEmitter APIs.
  const canHookProcess =
    typeof process !== 'undefined' && typeof process.on === 'function';

  if (canHookProcess) {
    if (uncaughtHandler) process.removeListener('uncaughtException', uncaughtHandler);
    if (rejectionHandler) process.removeListener('unhandledRejection', rejectionHandler);

    uncaughtHandler = async (err) => {
      await captureException(err);
      if (exitOnFatal && typeof process.exit === 'function') process.exit(1);
    };
    rejectionHandler = (reason) => {
      reason instanceof Error
        ? captureException(reason)
        : captureMessage(`Unhandled rejection: ${String(reason)}`);
    };
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', rejectionHandler);
  }
}
