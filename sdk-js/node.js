import { configure, captureException, captureMessage } from './core.js';

export { captureException, captureMessage };

/**
 * @param {{ dsn: string, endpoint: string, environment?: string, release?: string, tags?: object, exitOnFatal?: boolean }} options
 */
export function init(options = {}) {
  const exitOnFatal = options.exitOnFatal !== false;
  configure(options, () => ({ context: { node: process.version, platform: process.platform } }));
  process.on('uncaughtException', async (err) => {
    await captureException(err);
    if (exitOnFatal) process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    reason instanceof Error
      ? captureException(reason)
      : captureMessage(`Unhandled rejection: ${String(reason)}`);
  });
}
