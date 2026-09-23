import { configure, captureException, captureMessage, logger, resolveDsn } from './core.js';

export { captureException, captureMessage, logger, resolveDsn };

// re-init (e.g. in tests or hot-reload) would otherwise stack a duplicate pair of
// these listeners on `process` every call; drop the prior pair first.
let uncaughtHandler = null;
let rejectionHandler = null;

// A crashing process gets this long to report, so an unreachable ErrTap can't keep
// a corrupted process serving for the ~30s a full retry cycle takes.
const FATAL_FLUSH_MS = 2000;

/**
 * Node crashes on an unhandled rejection by default (`--unhandled-rejections=throw`),
 * but merely registering a listener switches that off. Keep the host's behaviour:
 * fatal unless the process explicitly opted into `warn` / `none`.
 */
function rejectionsAreFatal() {
  const args = [...(process.execArgv || []), ...String(process.env.NODE_OPTIONS || '').split(/\s+/)];
  const flag = args.find((a) => a.startsWith('--unhandled-rejections='));
  const mode = flag ? flag.slice('--unhandled-rejections='.length) : 'throw';
  return mode === 'throw' || mode === 'strict';
}

async function reportFatal(report) {
  await Promise.race([report(), new Promise((r) => setTimeout(r, FATAL_FLUSH_MS))]);
}

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
      if (!exitOnFatal) return void captureException(err);
      // listening suppresses Node's own crash output, so print it ourselves
      console.error(err);
      await reportFatal(() => captureException(err));
      if (typeof process.exit === 'function') process.exit(1);
    };
    rejectionHandler = async (reason) => {
      const report = () =>
        reason instanceof Error
          ? captureException(reason)
          : captureMessage(`Unhandled rejection: ${String(reason)}`);
      if (!exitOnFatal || !rejectionsAreFatal()) return void report();
      console.error(reason);
      await reportFatal(report);
      if (typeof process.exit === 'function') process.exit(1);
    };
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', rejectionHandler);
  }
}
