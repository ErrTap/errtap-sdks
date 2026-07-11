// Shared core for the browser and Node entrypoints. Each entry calls configure()
// with an environment-specific context provider and fetch options, then registers
// its own global error handlers.
let cfg = null;
let context = () => ({});
let fetchOpts = {};
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

export function configure(options, contextFn = () => ({}), extraFetchOpts = {}) {
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
  context = contextFn;
  fetchOpts = extraFetchOpts;
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
  return sendError(
    withBreadcrumbs({
      message: error.message || String(error),
      type: error.name || 'Error',
      stacktrace: error.stack,
      ...extra,
    }),
  );
}

export function captureMessage(message, extra = {}) {
  return sendError(withBreadcrumbs({ message, type: 'Message', ...extra }));
}

function sendError(payload) {
  if (!cfg) return;
  return fetch(cfg.endpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body: JSON.stringify({
      environment: cfg.environment,
      release: cfg.release,
      tags: cfg.tags,
      ...context(),
      ...payload,
    }),
    // never crash the host app over telemetry
  }).catch(() => {});
}

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  pushBreadcrumb(level, message, data);
  return fetch(cfg.logEndpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body: JSON.stringify({
      level,
      message: String(message).slice(0, 8192),
      environment: cfg.environment,
      release: cfg.release,
      tags: cfg.tags,
      context: data,
      ...context(),
    }),
  }).catch(() => {});
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};
