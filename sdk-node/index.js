// GENERATED FILE — do not edit. Source: sdk/sdk-js (core.js + node.js).
// Regenerate with: node sdk/sync.mjs

// Shared core for the browser and Node entrypoints. Each entry calls configure()
// with an environment-specific context provider and fetch options, then registers
// its own global error handlers.
let cfg = null;
let context = () => ({});
let fetchOpts = {};
/** @type {{ level: string, message: string, data?: object, ts: number }[]} */
const breadcrumbs = [];
const BREADCRUMB_MAX = 20;
const PAYLOAD_MAX_BYTES = 256 * 1024;
const TRANSPORT_TIMEOUT_MS = 10_000;
const TRANSPORT_RETRIES = 2;

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

function mergeTags(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    Object.assign(out, src);
  }
  return out;
}

function mergeContext(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      const existing = out[key];
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        out[key] = { ...existing, ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function withBreadcrumbs(payload) {
  if (!breadcrumbs.length) return payload;
  const existing = payload.context && typeof payload.context === 'object' ? payload.context : {};
  return {
    ...payload,
    context: { ...existing, breadcrumbs: breadcrumbs.slice() },
  };
}

function buildEnvelope(payload) {
  const runtime = context();
  const body = withBreadcrumbs({
    environment: cfg.environment,
    release: cfg.release,
    ...runtime,
    ...payload,
    tags: mergeTags(cfg.tags, runtime.tags, payload.tags),
    context: mergeContext(runtime.context, payload.context),
  });
  if (typeof body.message === 'string' && body.message.length > 8192) {
    body.message = body.message.slice(0, 8192);
  }
  if (typeof body.stacktrace === 'string' && body.stacktrace.length > 32_768) {
    body.stacktrace = body.stacktrace.slice(0, 32_768);
  }
  let json = JSON.stringify(body);
  if (json.length > PAYLOAD_MAX_BYTES) {
    json = JSON.stringify({
      ...body,
      message: String(body.message ?? '').slice(0, 4096),
      stacktrace: typeof body.stacktrace === 'string' ? body.stacktrace.slice(0, 8192) : undefined,
      truncated: true,
      originalBytes: json.length,
    }).slice(0, PAYLOAD_MAX_BYTES);
  }
  return json;
}

async function sendWithRetry(url, init) {
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { ...init, signal: controller?.signal });
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    } catch {
      if (timer) clearTimeout(timer);
      if (attempt < TRANSPORT_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
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
  return sendWithRetry(cfg.endpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body: buildEnvelope(payload),
  });
}

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  pushBreadcrumb(level, message, data);
  return sendWithRetry(cfg.logEndpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body: JSON.stringify({
      level,
      message: String(message).slice(0, 8192),
      environment: cfg.environment,
      release: cfg.release,
      tags: mergeTags(cfg.tags, context().tags),
      context: mergeContext(context().context, data),
      ...context(),
    }),
  });
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};

// test helpers (not part of the public API surface for apps)
export const __test = { mergeContext, mergeTags, buildEnvelope };

/**
 * @param {{ dsn: string, endpoint?: string, environment?: string, release?: string, tags?: object, exitOnFatal?: boolean }} options
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
