let cfg = null;
/** @type {{ level: string, message: string, data?: object, ts: number }[]} */
const breadcrumbs = [];
const BREADCRUMB_MAX = 20;

/**
 * Parse a Sentry-style URL DSN (`https://et_key@host[:port]`) or a bare key.
 * @param {string} dsn
 * @param {string} [endpointOverride]
 * @returns {{ key: string, endpoint: string, logEndpoint: string } | null}
 */
export function resolveDsn(dsn, endpointOverride) {
  if (!dsn) return null;
  if (dsn.includes('@')) {
    try {
      const u = new URL(dsn);
      const key = decodeURIComponent(u.username);
      if (!key) return null;
      const origin = u.origin;
      let logOrigin = origin;
      if (endpointOverride) {
        try {
          logOrigin = new URL(endpointOverride).origin;
        } catch {
          /* keep DSN origin */
        }
      }
      return {
        key,
        endpoint: endpointOverride || `${origin}/ingest/error`,
        logEndpoint: `${logOrigin}/ingest/log`,
      };
    } catch {
      return null;
    }
  }
  if (!endpointOverride) return null;
  let origin;
  try {
    origin = new URL(endpointOverride).origin;
  } catch {
    origin = null;
  }
  return {
    key: dsn,
    endpoint: endpointOverride,
    logEndpoint: origin ? `${origin}/ingest/log` : endpointOverride.replace(/\/ingest\/error\/?$/, '/ingest/log'),
  };
}

/**
 * @param {{ dsn: string, endpoint?: string, environment?: string, release?: string, tags?: object }} options
 */
export function init(options) {
  const resolved = resolveDsn(options.dsn, options.endpoint);
  if (!resolved) {
    cfg = null;
    return;
  }
  cfg = {
    environment: 'production',
    ...options,
    dsn: resolved.key,
    endpoint: resolved.endpoint,
    logEndpoint: resolved.logEndpoint,
  };
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

function pushBreadcrumb(level, message, data) {
  breadcrumbs.push({ level, message, data, ts: Date.now() });
  if (breadcrumbs.length > BREADCRUMB_MAX) breadcrumbs.shift();
}

function withBreadcrumbs(payload) {
  if (!breadcrumbs.length) return payload;
  const existing = payload.context && typeof payload.context === 'object' ? payload.context : {};
  return {
    ...payload,
    context: { ...existing, breadcrumbs: breadcrumbs.slice() },
  };
}

/** @param {Error} error */
export function captureException(error, extra = {}) {
  sendError(
    withBreadcrumbs({
      message: error.message || String(error),
      type: error.name || 'Error',
      stacktrace: error.stack,
      ...extra,
    }),
  );
}

export function captureMessage(message, extra = {}) {
  sendError(withBreadcrumbs({ message, type: 'Message', ...extra }));
}

function sendError(payload) {
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

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  pushBreadcrumb(level, message, data);
  const body = JSON.stringify({
    level,
    message: String(message).slice(0, 8192),
    environment: cfg.environment,
    release: cfg.release,
    tags: cfg.tags,
    url: typeof location !== 'undefined' ? location.href : undefined,
    context: data
      ? { ...data, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined }
      : { userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined },
  });
  fetch(cfg.logEndpoint, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body,
  }).catch(() => {});
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};
