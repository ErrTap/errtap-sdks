import {
  init as nodeInit,
  captureException,
  captureMessage,
  captureFeedback,
  lastEventId,
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

/**
 * Next.js instrumentation hook for request-time server errors.
 * Header values are deliberately excluded because they may contain credentials.
 */
export async function onRequestError(error, request = {}, context = {}) {
  const captured = error instanceof Error ? error : new Error(String(error));
  await captureException(captured, {
    url: request.path,
    tags: {
      method: request.method,
      routerKind: context.routerKind,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    context: {
      routePath: context.routePath,
      renderType: context.renderType,
      revalidateReason: context.revalidateReason,
    },
  });
}

export { captureException, captureMessage, captureFeedback, lastEventId, logger, resolveDsn };
