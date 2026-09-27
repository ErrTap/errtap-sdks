import { Platform } from 'react-native';

let cfg = null;
let errorHandlerInstalled = false;
let rejectionHandlerInstalled = false;
/** @type {{ level: string, message: string, data?: object, ts: number }[]} */
const breadcrumbs = [];
const BREADCRUMB_MAX = 20;
const PAYLOAD_MAX_BYTES = 256 * 1024;
// Field caps from the backend DTOs (backend/src/ingestion/ingestion.controller.ts and
// limits.ts). One field over its cap gets the whole event a 400, which is never retried,
// so the SDK must cut to fit rather than lose the event. Mirrors sdk/sdk-js/core.js.
const ERROR_MESSAGE_MAX = 2000; // ErrorEventDto.message
const LOG_MESSAGE_MAX = 8192; // LogEventDto.message
const STACKTRACE_MAX = 32_768; // under ErrorEventDto.stacktrace's 50,000
const FIELD_MAX = { environment: 100, release: 100, level: 50, type: 200, url: 2000, fingerprint: 200 };
const METADATA_MAX_BYTES = 32 * 1024; // MAX_INGEST_METADATA_BYTES, per tags/context/user
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

/** UTF-8 byte length, as the backend measures it. Exact without TextEncoder too
 *  (Hermes before React Native 0.74 has none); `.length` would undercount non-ASCII. */
function byteLength(s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).byteLength;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; } // surrogate pair
    else n += 3;
  }
  return n;
}

/** Cut every field to its backend cap; a metadata bag over its cap is dropped whole. */
function capFields(body) {
  const out = { ...body };
  for (const [key, max] of Object.entries(FIELD_MAX)) {
    if (typeof out[key] === 'string') out[key] = out[key].slice(0, max);
  }
  if (typeof out.stacktrace === 'string') out.stacktrace = out.stacktrace.slice(0, STACKTRACE_MAX);
  for (const key of ['tags', 'context', 'user']) {
    if (out[key] == null) continue;
    const json = stringifySafely(out[key]);
    if (json === null || byteLength(json) > METADATA_MAX_BYTES) {
      delete out[key];
      out.truncated = true;
    }
  }
  return out;
}

/**
 * Circular- and BigInt-safe, capped at the backend's size limits; null if unserializable.
 * Callers cap `message` to their own endpoint's limit before this.
 */
function serialize(payload) {
  const body = capFields(payload);
  const json = stringifySafely(body);
  if (json === null || byteLength(json) <= PAYLOAD_MAX_BYTES) return json;
  return stringifySafely({
    environment: body.environment,
    release: body.release,
    level: body.level,
    type: body.type,
    message: String(body.message ?? ''),
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
    message: String(rest.message ?? '').slice(0, ERROR_MESSAGE_MAX),
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
      message: String(message).slice(0, LOG_MESSAGE_MAX),
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
