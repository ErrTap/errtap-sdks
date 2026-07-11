import {
  init as nodeInit,
  captureException,
  captureMessage,
  logger,
  resolveDsn,
} from '@errtap/node';

/**
 * Init the Node SDK for Next.js server / edge workers that run Node.
 * `exitOnFatal` defaults to false so Next owns the process.
 * @param {import('@errtap/node').ErrTapOptions} options
 */
export function init(options) {
  return nodeInit({ exitOnFatal: false, ...options });
}

export { captureException, captureMessage, logger, resolveDsn };
