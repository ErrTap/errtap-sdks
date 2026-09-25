import { configure, captureException, captureFeedback, captureMessage, lastEventId, logger, resolveDsn, sendVitals } from './core.js';

export { captureException, captureFeedback, captureMessage, lastEventId, logger, resolveDsn };

let listenersInstalled = false;
let vitalsInstalled = false;

/**
 * @param {{ dsn: string, endpoint?: string, environment?: string, release?: string, tags?: object, vitals?: boolean, vitalsSampleRate?: number }} options
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
    // ponytail: a fixed per-page cap and dedupe window; make them options if a customer needs to tune them
    { dedupeMs: 60_000, maxPerMinute: 60, keepaliveMaxBytes: 60 * 1024 },
  );
  if (typeof window === 'undefined') return;
  if (!vitalsInstalled && options?.vitals !== false && Math.random() < (options?.vitalsSampleRate ?? 1)) {
    vitalsInstalled = true;
    try {
      trackVitals();
    } catch {
      /* telemetry must never break the page */
    }
  }
  if (listenersInstalled) return;
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

/**
 * Core Web Vitals for this page view, measured per the web.dev definitions without
 * the web-vitals dependency, and sent as one batch when the page is first hidden.
 */
function trackVitals() {
  if (typeof document === 'undefined' || typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') {
    return;
  }
  // ponytail: one report per hard page load, attributed to the landing URL — SPA soft
  // navigations and bfcache restores are not separate page views; add per-route reports if needed
  const url = typeof location !== 'undefined' ? location.origin + location.pathname : undefined;
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  const sinceActivation = (t) => Math.max(t - (nav?.activationStart || 0), 0);
  let firstHidden = document.visibilityState === 'hidden' ? 0 : Infinity;
  const values = {};
  const observers = new Map(); // entry type → [observer, handler]

  const observe = (type, handle, opts) => {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return false;
    try {
      const po = new PerformanceObserver((list) => handle(list.getEntries()));
      po.observe({ type, buffered: true, ...opts });
      observers.set(type, [po, handle]);
      return true;
    } catch {
      return false;
    }
  };
  const drain = (type) => {
    const [po, handle] = observers.get(type) || [];
    if (!po) return;
    observers.delete(type);
    handle(po.takeRecords());
    po.disconnect();
  };

  observe('paint', (entries) => {
    for (const e of entries) {
      if (e.name === 'first-contentful-paint' && e.startTime < firstHidden) values.FCP = sinceActivation(e.startTime);
    }
  });

  // LCP: the last candidate before the first input or the page going hidden
  observe('largest-contentful-paint', (entries) => {
    for (const e of entries) if (e.startTime < firstHidden) values.LCP = sinceActivation(e.startTime);
  });
  const stopLcp = () => drain('largest-contentful-paint');
  for (const type of ['keydown', 'click']) window.addEventListener(type, stopLcp, { once: true, capture: true });

  // CLS: the worst session window — shifts <1s apart, window capped at 5s
  values.CLS = 0;
  let session = 0;
  let sessionStart = 0;
  let lastShift = 0;
  const clsObserved = observe('layout-shift', (entries) => {
    for (const e of entries) {
      if (e.hadRecentInput) continue;
      if (session && e.startTime - lastShift < 1000 && e.startTime - sessionStart < 5000) session += e.value;
      else [session, sessionStart] = [e.value, e.startTime];
      lastShift = e.startTime;
      values.CLS = Math.max(values.CLS, session);
    }
  });
  if (!clsObserved) delete values.CLS;

  // INP: the longest interaction, skipping one outlier per 50 interactions (~p98)
  // ponytail: keeps only the 10 longest interactions, so the p98 pick is exact up to 500 interactions per page
  const longest = []; // [{ id, duration }], longest first
  const interactionIds = new Set();
  const onEvents = (entries) => {
    for (const e of entries) {
      if (!e.interactionId) continue;
      interactionIds.add(e.interactionId);
      const known = longest.find((x) => x.id === e.interactionId);
      if (known) known.duration = Math.max(known.duration, e.duration);
      else longest.push({ id: e.interactionId, duration: e.duration });
    }
    longest.sort((a, b) => b.duration - a.duration);
    longest.length = Math.min(longest.length, 10);
  };
  observe('event', onEvents, { durationThreshold: 40 });
  observe('first-input', onEvents);

  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    try {
      for (const type of [...observers.keys()]) drain(type);
      // ponytail: without performance.interactionCount, interactions under the 40ms
      // threshold go uncounted, so the outlier skip kicks in late on very busy pages
      const count = performance.interactionCount ?? interactionIds.size;
      const inp = longest[Math.min(longest.length - 1, Math.floor(count / 50))];
      if (inp) values.INP = inp.duration;
      if (nav?.responseStart > 0) values.TTFB = sinceActivation(nav.responseStart);
      const vitals = Object.entries(values)
        .filter(([, value]) => Number.isFinite(value))
        .map(([name, value]) => ({ name, value }));
      sendVitals(vitals, url)?.catch?.(() => {});
    } catch {
      /* never throw from a page lifecycle handler */
    }
  };
  // ponytail: reports at the first hide only — CLS/INP after the user returns to the tab are not counted
  window.addEventListener(
    'visibilitychange',
    (e) => {
      if (document.visibilityState !== 'hidden') return;
      firstHidden = Math.min(firstHidden, e?.timeStamp ?? 0);
      report();
    },
    true,
  );
  window.addEventListener('pagehide', report, true);
}
