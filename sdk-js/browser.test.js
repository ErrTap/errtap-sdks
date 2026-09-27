import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureException, init } from './browser.js';

describe('browser runtime handlers', () => {
  it('installs each global listener only once across repeated init calls', () => {
    const originalWindow = globalThis.window;
    const listeners = new Map();
    globalThis.window = {
      addEventListener(type, handler) {
        const handlers = listeners.get(type) || [];
        handlers.push(handler);
        listeners.set(type, handlers);
      },
    };
    try {
      init({ dsn: 'et_first', endpoint: 'https://example.test/ingest/error' });
      init({ dsn: 'et_second', endpoint: 'https://example.test/ingest/error' });

      assert.equal(listeners.get('error')?.length, 1);
      assert.equal(listeners.get('unhandledrejection')?.length, 1);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe('browser send limits', () => {
  const withFetch = async (fn) => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      calls.push(init);
      return { ok: true, status: 202, headers: new Headers() };
    };
    try {
      await fn(calls);
    } finally {
      globalThis.fetch = original;
    }
  };

  it('sends a looping error once per minute instead of every iteration', async () => {
    await withFetch(async (calls) => {
      init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      const err = new Error('render loop');
      for (let i = 0; i < 100; i++) await captureException(err);
      assert.equal(calls.length, 1);
    });
  });

  it('caps distinct errors per minute so one bad page cannot drain the quota', async () => {
    await withFetch(async (calls) => {
      init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      for (let i = 0; i < 100; i++) await captureException(new Error(`distinct ${i}`));
      assert.equal(calls.length, 60);
    });
  });

  it('drops keepalive for bodies the browser would reject', async () => {
    await withFetch(async (calls) => {
      init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      await captureException(new Error('small'));
      // each bag stays under the backend's 32KB metadata cap; together they pass 64KB
      const blob = () => ({ blob: 'x'.repeat(30 * 1024) });
      await captureException(new Error('large'), { context: blob(), tags: blob(), user: blob() });
      assert.equal(calls[0].keepalive, true);
      assert.equal(calls[1].keepalive, false);
    });
  });

  it('gives logs and errors separate per-minute budgets', async () => {
    await withFetch(async (calls) => {
      init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      const { logger } = await import('./browser.js');
      for (let i = 0; i < 80; i++) await logger.info(`log ${i}`);
      await captureException(new Error('after a log flood'));
      assert.equal(calls.filter((c) => c.body.includes('after a log flood')).length, 1);
    });
  });

  it('keeps concurrent keepalive bodies within the browser-wide budget', async () => {
    const original = globalThis.fetch;
    const calls = [];
    let release;
    const gate = new Promise((r) => (release = r));
    globalThis.fetch = async (_url, req) => {
      calls.push(req);
      await gate;
      return { ok: true, status: 202, headers: new Headers() };
    };
    try {
      init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      const sends = [1, 2, 3, 4].map((i) =>
        captureException(new Error(`concurrent ${i}`), { context: { blob: 'x'.repeat(20 * 1024) } }),
      );
      await new Promise((r) => setImmediate(r));
      const keptAlive = calls.filter((c) => c.keepalive).reduce((n, c) => n + Buffer.byteLength(c.body), 0);
      assert.ok(keptAlive <= 60 * 1024, `${keptAlive} keepalive bytes in flight`);
      assert.ok(calls.some((c) => c.keepalive === false), 'overflow goes out as a normal fetch');
      release();
      await Promise.all(sends);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('web vitals', () => {
  const GLOBALS = ['window', 'document', 'PerformanceObserver', 'performance', 'location', 'fetch'];
  let saved;
  let fresh = 0;

  // A fake page: PerformanceObserver entries are pushed by the test, lifecycle events fired by hand.
  function fakePage({ supported = ['paint', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input'], nav, interactionCount, withObserver = true } = {}) {
    const listeners = new Map();
    const observers = {};
    const sent = [];
    class FakeObserver {
      static supportedEntryTypes = supported;
      constructor(cb) {
        this.cb = cb;
        this.pending = [];
      }
      observe({ type }) {
        observers[type] = this;
      }
      takeRecords() {
        return this.pending.splice(0);
      }
      disconnect() {
        this.off = true;
      }
    }
    const values = {
      window: {
        addEventListener(type, fn) {
          listeners.set(type, [...(listeners.get(type) || []), fn]);
        },
      },
      document: { visibilityState: 'visible' },
      PerformanceObserver: withObserver ? FakeObserver : undefined,
      performance: {
        getEntriesByType: (t) => (t === 'navigation' && nav ? [nav] : []),
        interactionCount,
      },
      location: { origin: 'https://app.test', pathname: '/checkout', href: 'https://app.test/checkout?token=secret#x' },
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive });
        return { ok: true, status: 202, headers: new Headers() };
      },
    };
    for (const [k, v] of Object.entries(values)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    const fire = (type, event = {}) => (listeners.get(type) || []).forEach((fn) => fn(event));
    return {
      sent,
      observers,
      fire,
      emit(type, entries) {
        const po = observers[type];
        if (po && !po.off) po.cb({ getEntries: () => entries });
      },
      async hide(timeStamp = 60_000) {
        values.document.visibilityState = 'hidden';
        fire('visibilitychange', { timeStamp });
        fire('pagehide');
        await new Promise((r) => setImmediate(r));
      },
    };
  }

  // browser.js installs vitals once per module, so each test loads a fresh copy
  const load = async () => (await import(`./browser.js?vitals=${++fresh}`)).init;
  const vitalsOf = (page) => Object.fromEntries(page.sent[0].body.vitals.map((v) => [v.name, v.value]));

  beforeEach(() => {
    saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  });
  afterEach(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  });

  it('sends one batched payload matching VitalsDto when the page is hidden', async () => {
    const page = fakePage({ nav: { responseStart: 120, activationStart: 20 } });
    (await load())({ dsn: 'https://et_k@ingest.test', environment: 'staging', release: '1.2.3' });
    page.emit('paint', [{ name: 'first-paint', startTime: 50 }, { name: 'first-contentful-paint', startTime: 220 }]);
    page.emit('largest-contentful-paint', [{ startTime: 400 }, { startTime: 1020 }]);
    page.emit('layout-shift', [{ startTime: 300, value: 0.05, hadRecentInput: false }]);
    page.emit('event', [{ interactionId: 7, duration: 88 }]);
    await page.hide();

    assert.equal(page.sent.length, 1, 'visibilitychange + pagehide report once');
    const [{ url, body, keepalive }] = page.sent;
    assert.equal(url, 'https://ingest.test/ingest/vitals');
    assert.equal(keepalive, true);
    assert.deepEqual(Object.keys(body).sort(), ['environment', 'vitals']);
    assert.equal(body.environment, 'staging');
    assert.deepEqual(vitalsOf(page), { FCP: 200, LCP: 1000, CLS: 0.05, INP: 88, TTFB: 100 });
    for (const v of body.vitals) assert.equal(v.url, 'https://app.test/checkout', 'query string and hash stripped');
  });

  it('freezes LCP at the first input and ignores paints after the page was hidden', async () => {
    const page = fakePage();
    (await load())({ dsn: 'https://et_k@ingest.test' });
    page.emit('largest-contentful-paint', [{ startTime: 500 }]);
    page.observers['largest-contentful-paint'].pending.push({ startTime: 800 });
    page.fire('click');
    page.emit('largest-contentful-paint', [{ startTime: 2000 }]);
    // delivered by takeRecords() during the hide, but painted after it
    page.observers.paint.pending.push({ name: 'first-contentful-paint', startTime: 70_000 });
    await page.hide(60_000);
    const v = vitalsOf(page);
    assert.equal(v.LCP, 800);
    assert.equal(v.FCP, undefined);
  });

  it('reports CLS as the worst session window (1s gap, 5s cap), skipping input-driven shifts', async () => {
    const page = fakePage();
    (await load())({ dsn: 'https://et_k@ingest.test' });
    const shift = (startTime, value, hadRecentInput = false) => ({ startTime, value, hadRecentInput });
    page.emit('layout-shift', [
      shift(0, 0.1),
      shift(500, 0.1), // same window: 0.2
      shift(700, 0.5, true), // after input: ignored
      shift(2000, 0.15), // >1s gap: new window
      // shifts 900ms apart: the 5s cap splits them into 0.24 (6 shifts) + 0.04
      ...[10_000, 10_900, 11_800, 12_700, 13_600, 14_500, 15_400].map((t) => shift(t, 0.04)),
    ]);
    await page.hide();
    assert.ok(Math.abs(vitalsOf(page).CLS - 0.24) < 1e-9, `CLS ${vitalsOf(page).CLS}`);
  });

  it('picks INP as the p98 interaction, grouping entries by interactionId', async () => {
    const page = fakePage({ interactionCount: 120 });
    (await load())({ dsn: 'https://et_k@ingest.test' });
    page.emit('first-input', [{ interactionId: 1, duration: 16 }]);
    page.emit('event', [
      { interactionId: 0, duration: 900 }, // not an interaction (e.g. mousemove)
      { interactionId: 2, duration: 400 },
      { interactionId: 2, duration: 480 }, // same interaction: longest entry wins
      { interactionId: 3, duration: 300 },
      { interactionId: 4, duration: 200 },
      { interactionId: 5, duration: 100 },
    ]);
    await page.hide();
    // 120 interactions → skip the 2 worst (floor(120/50)) → third longest
    assert.equal(vitalsOf(page).INP, 200);
  });

  it('uses the longest interaction when interactionCount is unsupported', async () => {
    const page = fakePage();
    (await load())({ dsn: 'https://et_k@ingest.test' });
    page.emit('event', [{ interactionId: 1, duration: 120 }, { interactionId: 2, duration: 56 }]);
    await page.hide();
    assert.equal(vitalsOf(page).INP, 120);
  });

  it('sends nothing when opted out or sampled out', async () => {
    for (const opts of [{ vitals: false }, { vitalsSampleRate: 0 }]) {
      const page = fakePage({ nav: { responseStart: 90 } });
      (await load())({ dsn: 'https://et_k@ingest.test', ...opts });
      assert.deepEqual(Object.keys(page.observers), [], 'no observers installed');
      await page.hide();
      assert.equal(page.sent.length, 0);
    }
  });

  it('does not throw without PerformanceObserver or with unsupported entry types', async () => {
    const bare = fakePage({ withObserver: false });
    (await load())({ dsn: 'https://et_k@ingest.test' });
    await bare.hide();
    assert.equal(bare.sent.length, 0);

    const old = fakePage({ supported: null, nav: { responseStart: 90 } });
    (await load())({ dsn: 'https://et_k@ingest.test' });
    await old.hide();
    assert.deepEqual(vitalsOf(old), { TTFB: 90 });
  });

  it('derives the vitals route from a custom endpoint origin', async () => {
    const page = fakePage({ nav: { responseStart: 90 } });
    (await load())({ dsn: 'https://et_k@ingest.test', endpoint: 'https://proxy.test/ingest/error' });
    await page.hide();
    assert.equal(page.sent[0].url, 'https://proxy.test/ingest/vitals');
  });
});
