import { Platform } from 'react-native';

let cfg = null;
let errorHandlerInstalled = false;
let rejectionHandlerInstalled = false;
/** @type {{ level: string, message: string, data?: object, ts: number }[]} */
const breadcrumbs = [];
const BREADCRUMB_MAX = 20;
const PAYLOAD_MAX_BYTES = 256 * 1024;
const SEND_TIMEOUT_MS = 10_000;
// A fatal JS error gets this long to reach ErrTap (or storage) before React
// Native's own handler, which ends a release build, is allowed to run.
const FATAL_FLUSH_MS = 2000;
const PENDING_FATAL_KEY = 'errtap:pending-fatal';

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
// De-minify production stacks by uploading the release bundle's source map with the
// `errtap-upload-sourcemaps` CLI (see upload-sourcemaps.mjs). With Hermes, upload the
// *composed* map so columns line up. Set the same `release` here and on the upload.
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

  const errorUtils = globalThis.ErrorUtils;
  if (
    !errorHandlerInstalled &&
    typeof errorUtils?.getGlobalHandler === 'function' &&
    typeof errorUtils?.setGlobalHandler === 'function'
  ) {
    const previousHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      // React Native's own handling must run exactly once, whatever happens here
      const next = () => {
        if (typeof previousHandler === 'function') previousHandler(error, isFatal);
      };
      try {
        if (!isFatal || globalThis.__DEV__) {
          captureException(error, { tags: { fatal: !!isFatal } });
          next();
          return;
        }
        // In release builds the previous handler ends the app, so a fire-and-forget
        // send almost never leaves the device. Wait (bounded) for send-or-store.
        Promise.race([reportFatal(error), new Promise((r) => setTimeout(r, FATAL_FLUSH_MS))])
          .catch(() => {})
          .then(next);
      } catch {
        next();
      }
    });
    errorHandlerInstalled = true;
  }

  if (cfg.storage) void resendPendingFatal(cfg.storage);

  // Hermes exposes a rejection tracker in production. Do not replace React
  // Native's development tracker, and do not monkey-patch Promise on runtimes
  // without this existing hook.
  const enableRejectionTracker = globalThis.HermesInternal?.enablePromiseRejectionTracker;
  if (!rejectionHandlerInstalled && !globalThis.__DEV__ && typeof enableRejectionTracker === 'function') {
    enableRejectionTracker.call(globalThis.HermesInternal, {
      allRejections: true,
      onUnhandled(_id, reason) {
        reason instanceof Error
          ? captureException(reason, { tags: { unhandledPromise: true } })
          : captureMessage(`Unhandled rejection: ${String(reason)}`, {
              tags: { unhandledPromise: true },
            });
      },
    });
    rejectionHandlerInstalled = true;
  }
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

function platformContext() {
  return {
    os: Platform.OS,
    osVersion: String(Platform.Version),
  };
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

function byteLength(value) {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).byteLength : value.length;
}

/** Circular- and BigInt-safe, capped at the backend's size limit; null if unserializable. */
function serialize(body) {
  const json = stringifySafely(body);
  if (json === null || byteLength(json) <= PAYLOAD_MAX_BYTES) return json;
  return stringifySafely({
    environment: body.environment,
    release: body.release,
    level: body.level,
    type: typeof body.type === 'string' ? body.type.slice(0, 512) : undefined,
    message: String(body.message ?? '').slice(0, 4096),
    stacktrace: typeof body.stacktrace === 'string' ? body.stacktrace.slice(0, 8192) : undefined,
    tags: body.tags,
    truncated: true,
  });
}

function eventId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function safely(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** Resolves true once the event needs no resend: accepted, or rejected in a way a resend won't fix. */
function post(url, body, idempotencyKey) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SEND_TIMEOUT_MS) : null;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DSN ${cfg.dsn}`,
      'Idempotency-Key': idempotencyKey,
    },
    body,
    signal: controller?.signal,
  })
    .then((res) => res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429))
    .catch(() => false)
    .finally(() => timer && clearTimeout(timer));
}

function exceptionPayload(error, extra) {
  // anything can be thrown, including null
  const e = error !== null && typeof error === 'object' ? error : {};
  return {
    message: e.message || String(error),
    type: e.name || 'Error',
    stacktrace: e.stack,
    ...extra,
  };
}

function errorBody(payload) {
  const { tags: pTags, context: pCtx, ...rest } = payload;
  return serialize({
    environment: cfg.environment,
    release: cfg.release,
    ...rest,
    tags: { platform: 'react-native', ...cfg.tags, ...(pTags || {}) },
    context: { ...platformContext(), ...(pCtx || {}) },
  });
}

/** @param {Error} error — anything thrown is accepted */
export function captureException(error, extra = {}) {
  sendError(withBreadcrumbs(exceptionPayload(error, extra)));
}

export function captureMessage(message, extra = {}) {
  sendError(withBreadcrumbs({ message, type: 'Message', ...extra }));
}

function sendError(payload) {
  if (!cfg) return Promise.resolve(false);
  try {
    const body = errorBody(payload);
    return body === null ? Promise.resolve(false) : post(cfg.endpoint, body, eventId());
  } catch {
    return Promise.resolve(false); // telemetry never throws into the app
  }
}

/**
 * Fatal path: with `storage`, persist first so an app that dies mid-request still
 * reports on next launch (same idempotency key, so a copy that did land is stored once).
 */
async function reportFatal(error) {
  if (!cfg) return;
  const body = errorBody(withBreadcrumbs(exceptionPayload(error, { tags: { fatal: true } })));
  if (body === null) return;
  const id = eventId();
  const storage = cfg.storage;
  if (storage) await safely(() => storage.setItem(PENDING_FATAL_KEY, JSON.stringify({ body, id })));
  if ((await post(cfg.endpoint, body, id)) && storage) {
    await safely(() => storage.removeItem(PENDING_FATAL_KEY));
  }
}

async function resendPendingFatal(storage) {
  const raw = await safely(() => storage.getItem(PENDING_FATAL_KEY));
  if (!raw) return;
  let pending;
  try {
    pending = JSON.parse(raw);
  } catch {
    await safely(() => storage.removeItem(PENDING_FATAL_KEY));
    return;
  }
  if (typeof pending?.body !== 'string') return void safely(() => storage.removeItem(PENDING_FATAL_KEY));
  if (await post(cfg.endpoint, pending.body, pending.id || eventId())) {
    await safely(() => storage.removeItem(PENDING_FATAL_KEY));
  }
}

function sendLog(level, message, data) {
  if (!cfg?.logEndpoint) return;
  try {
    pushBreadcrumb(level, message, data);
    const body = serialize({
      level,
      message: String(message).slice(0, 8192),
      environment: cfg.environment,
      release: cfg.release,
      tags: { platform: 'react-native', ...cfg.tags },
      context: { ...platformContext(), ...(data || {}) },
    });
    if (body !== null) void post(cfg.logEndpoint, body, eventId());
  } catch {
    // telemetry never throws into the app
  }
}

export const logger = {
  debug: (message, data) => sendLog('debug', message, data),
  info: (message, data) => sendLog('info', message, data),
  warn: (message, data) => sendLog('warning', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
};
