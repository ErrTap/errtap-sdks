import { describe, it } from 'node:test';
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
      await captureException(new Error('large'), { context: { blob: 'x'.repeat(100 * 1024) } });
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
