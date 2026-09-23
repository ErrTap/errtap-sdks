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
});
