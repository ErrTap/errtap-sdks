import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureException, configure, logger } from './core.js';

describe('sdk core transport', () => {
  it('keeps oversized payloads valid JSON within the transport limit', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, init) => {
      request = init;
      return { ok: true };
    };
    try {
      configure({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      await captureException(new Error('oversized'), { context: { huge: 'x'.repeat(300_000) } });

      assert.ok(Buffer.byteLength(request.body) <= 256 * 1024);
      assert.doesNotThrow(() => JSON.parse(request.body));
      assert.equal(JSON.parse(request.body).truncated, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never throws circular context into the host application', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, init) => {
      request = init;
      return { ok: true };
    };
    try {
      configure({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      const context = {};
      context.self = context;

      await assert.doesNotReject(captureException(new Error('circular'), { context }));
      assert.doesNotThrow(() => JSON.parse(request.body));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves runtime and call-site structured log context', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (_url, init) => {
      request = init;
      return { ok: true };
    };
    try {
      configure(
        { dsn: 'et_test', endpoint: 'https://example.test/ingest/error' },
        () => ({ context: { requestId: 'req_1' }, tags: { runtime: 'node' }, url: '/orders' }),
      );
      await logger.info('order created', { orderId: 'ord_1' });

      const body = JSON.parse(request.body);
      assert.deepEqual(body.context, { requestId: 'req_1', orderId: 'ord_1' });
      assert.deepEqual(body.tags, { runtime: 'node' });
      assert.equal(body.url, '/orders');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reuses one idempotency key across transport retries', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(init);
      if (requests.length === 1) throw new Error('response lost');
      return { ok: true };
    };
    try {
      configure({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
      await captureException(new Error('retry once'));
      assert.equal(requests.length, 2);
      assert.ok(requests[0].headers['Idempotency-Key']);
      assert.equal(
        requests[0].headers['Idempotency-Key'],
        requests[1].headers['Idempotency-Key'],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
