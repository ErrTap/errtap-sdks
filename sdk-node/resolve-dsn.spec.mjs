import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDsn } from './index.js';

describe('resolveDsn', () => {
  it('parses a URL DSN into key + derived endpoints', () => {
    const r = resolveDsn('https://et_abc123@api.example.com');
    assert.deepEqual(r, {
      key: 'et_abc123',
      endpoint: 'https://api.example.com/ingest/error',
      logEndpoint: 'https://api.example.com/ingest/log',
    });
  });

  it('keeps port on the derived origin', () => {
    const r = resolveDsn('http://et_key@localhost:4000');
    assert.equal(r.endpoint, 'http://localhost:4000/ingest/error');
    assert.equal(r.logEndpoint, 'http://localhost:4000/ingest/log');
  });

  it('allows endpoint override on a URL DSN', () => {
    const r = resolveDsn('https://et_abc@api.example.com', 'https://proxy.example.com/ingest/error');
    assert.equal(r.key, 'et_abc');
    assert.equal(r.endpoint, 'https://proxy.example.com/ingest/error');
    assert.equal(r.logEndpoint, 'https://proxy.example.com/ingest/log');
  });

  it('requires endpoint for bare keys', () => {
    assert.equal(resolveDsn('et_bare'), null);
    const r = resolveDsn('et_bare', 'https://api.example.com/ingest/error');
    assert.deepEqual(r, {
      key: 'et_bare',
      endpoint: 'https://api.example.com/ingest/error',
      logEndpoint: 'https://api.example.com/ingest/log',
    });
  });
});
