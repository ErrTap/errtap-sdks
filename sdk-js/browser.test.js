import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { init } from './browser.js';

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
