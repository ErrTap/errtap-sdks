let cfg = null;

/**
 * @param {{ dsn: string, endpoint: string, environment?: string, release?: string, tags?: object }} options
 */
export function init(options) {
  cfg = { environment: 'production', ...options };
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

/** @param {Error} error */
export function captureException(error, extra = {}) {
  send({
    message: error.message || String(error),
    type: error.name || 'Error',
    stacktrace: error.stack,
    ...extra,
  });
}

export function captureMessage(message, extra = {}) {
  send({ message, type: 'Message', ...extra });
}

function send(payload) {
  if (!cfg) return;
  const body = JSON.stringify({
    environment: cfg.environment,
    release: cfg.release,
    tags: cfg.tags,
    url: typeof location !== 'undefined' ? location.href : undefined,
    context: { userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined },
    ...payload,
  });
  // ponytail: sendBeacon can't carry the Authorization header, so keepalive fetch is the send path
  fetch(cfg.endpoint, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body,
  }).catch(() => {});
}
