import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ErrTapExceptionFilter, init } from './index.js';

test('reports server failures but not routine 4xx responses', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, request) => {
    requests.push({ url, request });
    return { ok: true };
  };
  try {
    init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error' });
    const adapter = {
      isHeadersSent: () => false,
      reply: () => undefined,
      end: () => undefined,
    };
    const host = { getArgByIndex: () => ({}) };
    const filter = new ErrTapExceptionFilter(adapter);

    filter.catch(new BadRequestException('invalid input'), host);
    assert.equal(requests.length, 0);

    filter.catch(new InternalServerErrorException('database unavailable'), host);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
