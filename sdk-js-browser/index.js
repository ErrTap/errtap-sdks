// GENERATED FILE — do not edit. Source: sdk/sdk-js (core.js + browser.js).
// Regenerate with: node sdk/sync.mjs

// Shared core for the browser and Node entrypoints. Each entry calls configure()
// with an environment-specific context provider and fetch options, then registers
// its own global error handlers.
let cfg = null;
let context = () => ({});
let fetchOpts = {};
const PAYLOAD_MAX_BYTES = 256 * 1024;
const TRANSPORT_TIMEOUT_MS = 10_000;
const TRANSPORT_RETRIES = 2;
const RETRY_AFTER_DEFAULT_MS = 60_000; // the backend's rate windows are per minute
const RETRY_AFTER_MAX_MS = 60 * 60_000;
// set by a 429: every send is dropped until then instead of piling onto a full window
let pausedUntil = 0;

function telemetryId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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

function configure(options, contextFn = () => ({}), extraFetchOpts = {}) {
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
  pausedUntil = 0;
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

function runtimeContext() {
  try {
    const value = context();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function jsonBytes(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function stringifySafely(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    return null;
  }
}

function serializePayload(body) {
  const json = stringifySafely(body);
  if (json === null || jsonBytes(json) <= PAYLOAD_MAX_BYTES) return json;

  // Keep a valid, useful envelope instead of cutting a JSON string mid-value.
  return stringifySafely({
    environment: typeof body.environment === 'string' ? body.environment.slice(0, 256) : undefined,
    release: typeof body.release === 'string' ? body.release.slice(0, 512) : undefined,
    level: typeof body.level === 'string' ? body.level.slice(0, 64) : undefined,
    type: typeof body.type === 'string' ? body.type.slice(0, 512) : undefined,
    message: String(body.message ?? '').slice(0, 4096),
    stacktrace: typeof body.stacktrace === 'string' ? body.stacktrace.slice(0, 8192) : undefined,
    url: typeof body.url === 'string' ? body.url.slice(0, 2048) : undefined,
    truncated: true,
    originalBytes: jsonBytes(json),
  });
}

function buildEnvelope(payload) {
  const runtime = runtimeContext();
  const body = {
    environment: cfg.environment,
    release: cfg.release,
    ...runtime,
    ...payload,
    tags: mergeTags(cfg.tags, runtime.tags, payload.tags),
    context: mergeContext(runtime.context, payload.context),
  };
  if (typeof body.message === 'string' && body.message.length > 8192) {
    body.message = body.message.slice(0, 8192);
  }
  if (typeof body.stacktrace === 'string' && body.stacktrace.length > 32_768) {
    body.stacktrace = body.stacktrace.slice(0, 32_768);
  }
  return serializePayload(body);
}

function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  if (raw == null) return RETRY_AFTER_DEFAULT_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : RETRY_AFTER_DEFAULT_MS;
}

async function sendWithRetry(url, init) {
  if (Date.now() < pausedUntil) return;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { ...init, signal: controller?.signal });
      if (timer) clearTimeout(timer);
      if (res.ok) return;
      if (res.status === 429) {
        pausedUntil = Date.now() + Math.min(retryAfterMs(res), RETRY_AFTER_MAX_MS);
        return;
      }
      // other 4xx (bad DSN, too large) fail identically on retry
      if (res.status !== 408 && res.status < 500) return;
    } catch {
      if (timer) clearTimeout(timer); // network error or timeout: worth retrying
    }
    if (attempt < TRANSPORT_RETRIES) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

/** @param {Error} error */
export function captureException(error, extra = {}) {
  return sendError(
    {
      message: error.message || String(error),
      type: error.name || 'Error',
      stacktrace: error.stack,
      ...extra,
    },
  );
}

export function captureMessage(message, extra = {}) {
  return sendError({ message, type: 'Message', ...extra });
}

function sendError(payload) {
  if (!cfg) return;
  const body = buildEnvelope(payload);
  if (body === null) return Promise.resolve();
  return sendWithRetry(cfg.endpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DSN ${cfg.dsn}`,
      'Idempotency-Key': telemetryId(),
    },
    body,
  });
}

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  const runtime = runtimeContext();
  const body = serializePayload({
    ...runtime,
    level,
    message: String(message).slice(0, 8192),
    environment: cfg.environment,
    release: cfg.release,
    tags: mergeTags(cfg.tags, runtime.tags),
    context: mergeContext(runtime.context, data),
  });
  if (body === null) return Promise.resolve();
  return sendWithRetry(cfg.logEndpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DSN ${cfg.dsn}`,
      'Idempotency-Key': telemetryId(),
    },
    body,
  });
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};

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
