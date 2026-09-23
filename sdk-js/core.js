// Shared core for the browser and Node entrypoints. Each entry calls configure()
// with an environment-specific context provider and fetch options, then registers
// its own global error handlers.
let cfg = null;
let context = () => ({});
let fetchOpts = {};
// per-runtime send limits (the browser sets these; see browser.js)
let limits = {};
let recentErrors = new Map();
// Errors and logs get separate budgets, pauses and in-flight caps, like the backend's
// separate ingest windows: a chatty logger must never starve error delivery.
let minuteWindows = new Map(); // kind → { start, count }
const PAYLOAD_MAX_BYTES = 256 * 1024;
const TRANSPORT_TIMEOUT_MS = 10_000;
const TRANSPORT_RETRIES = 2;
const RETRY_AFTER_DEFAULT_MS = 60_000; // the backend's rate windows are per minute
const RETRY_AFTER_MAX_MS = 60 * 60_000;
// set by a 429, per endpoint: its sends are dropped until then instead of piling onto
// a full window
let pausedUntil = new Map();
// When the host is failing, every request throws. Past this many unfinished sends to
// one endpoint, drop new telemetry rather than pile up sockets and memory in the host.
const MAX_IN_FLIGHT = 100;
const inFlight = new Map();
// Browsers cap keepalive bodies at 64KB summed across every keepalive request in
// flight, not per request; past the budget a send must go as a normal fetch.
let keepaliveBytesInFlight = 0;

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

export function configure(options, contextFn = () => ({}), extraFetchOpts = {}, sendLimits = {}) {
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
  limits = sendLimits;
  recentErrors = new Map();
  minuteWindows = new Map();
  pausedUntil = new Map();
  // inFlight survives re-init: those requests are still under way
}

/** Per-minute cap per kind: one looping error must not burn the project's rate limit and quota. */
function withinRate(kind) {
  if (!limits.maxPerMinute) return true;
  const now = Date.now();
  let window = minuteWindows.get(kind);
  if (!window || now - window.start >= 60_000) {
    window = { start: now, count: 0 };
    minuteWindows.set(kind, window);
  }
  return ++window.count <= limits.maxPerMinute;
}

/** Drop an error identical to one sent within `dedupeMs` (render loops, rAF, intervals). */
function isRepeat(payload) {
  if (!limits.dedupeMs) return false;
  const key = `${payload.type}|${payload.message}|${String(payload.stacktrace ?? '').slice(0, 1000)}`;
  const now = Date.now();
  const last = recentErrors.get(key);
  if (last !== undefined && now - last < limits.dedupeMs) return true;
  recentErrors.delete(key); // re-insert so the map stays in recency order
  recentErrors.set(key, now);
  if (recentErrors.size > 200) recentErrors.delete(recentErrors.keys().next().value);
  return false;
}

function transportInit(body) {
  const init = {
    method: 'POST',
    ...fetchOpts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DSN ${cfg.dsn}`,
      'Idempotency-Key': telemetryId(),
    },
    body,
  };
  return init;
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
  if (Date.now() < (pausedUntil.get(url) ?? 0)) return;
  const pending = inFlight.get(url) ?? 0;
  if (pending >= MAX_IN_FLIGHT) return;
  inFlight.set(url, pending + 1);
  try {
    await attemptSend(url, init);
  } finally {
    inFlight.set(url, (inFlight.get(url) ?? 1) - 1);
  }
}

async function attemptSend(url, init) {
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS) : null;
    // reserve keepalive budget for this attempt, or send without keepalive
    const bytes = init.keepalive && limits.keepaliveMaxBytes ? jsonBytes(init.body) : 0;
    const keepalive = bytes > 0 && keepaliveBytesInFlight + bytes <= limits.keepaliveMaxBytes;
    if (keepalive) keepaliveBytesInFlight += bytes;
    try {
      const res = await fetch(url, {
        ...init,
        ...(bytes > 0 ? { keepalive } : {}),
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);
      if (res.ok) return;
      if (res.status === 429) {
        pausedUntil.set(url, Date.now() + Math.min(retryAfterMs(res), RETRY_AFTER_MAX_MS));
        return;
      }
      // other 4xx (bad DSN, too large) fail identically on retry
      if (res.status !== 408 && res.status < 500) return;
    } catch {
      if (timer) clearTimeout(timer); // network error or timeout: worth retrying
    } finally {
      if (keepalive) keepaliveBytesInFlight -= bytes;
    }
    if (attempt < TRANSPORT_RETRIES) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

/** @param {Error} error — anything thrown is accepted, including `throw null` */
export function captureException(error, extra = {}) {
  const e = error !== null && typeof error === 'object' ? error : {};
  return sendError(
    {
      message: e.message || String(error),
      type: e.name || 'Error',
      stacktrace: e.stack,
      ...extra,
    },
  );
}

export function captureMessage(message, extra = {}) {
  return sendError({ message, type: 'Message', ...extra });
}

function sendError(payload) {
  if (!cfg) return;
  if (isRepeat(payload) || !withinRate('error')) return Promise.resolve();
  const body = buildEnvelope(payload);
  if (body === null) return Promise.resolve();
  return sendWithRetry(cfg.endpoint, transportInit(body));
}

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  if (!withinRate('log')) return Promise.resolve();
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
  return sendWithRetry(cfg.logEndpoint, transportInit(body));
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};
