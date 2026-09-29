import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// 'react-native' doesn't exist under plain Node: stub the one export the SDK uses.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native') {
      return { url: 'data:text/javascript,export const Platform = { OS: "ios", Version: "18.0" };', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

let installed;
const order = [];
const previous = (error, isFatal) => order.push(`previous:${isFatal}`);
globalThis.ErrorUtils = { getGlobalHandler: () => previous, setGlobalHandler: (h) => (installed = h) };
const sdk = await import('./index.js');

const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => void map.set(k, v), removeItem: async (k) => void map.delete(k) };
};
const init = (extra = {}) => sdk.init({ dsn: 'et_test', endpoint: 'https://example.test/ingest/error', ...extra });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('a fatal crash waits for its report before React Native ends the app', async () => {
  order.length = 0;
  globalThis.fetch = async () => {
    await tick(50);
    order.push('sent');
    return { ok: true, status: 202 };
  };
  init();
  installed(new Error('fatal boom'), true);
  assert.deepEqual(order, [], 'the previous (app-ending) handler must not run synchronously');
  await tick(150);
  assert.deepEqual(order, ['sent', 'previous:true']);
});

test('the wait is bounded when the network hangs', async () => {
  order.length = 0;
  globalThis.fetch = () => new Promise(() => {});
  init();
  const t0 = Date.now();
  installed(new Error('fatal offline'), true);
  while (!order.includes('previous:true')) await tick(50);
  const waited = Date.now() - t0;
  assert.ok(waited >= 1900 && waited < 3000, `handed off after ${waited}ms`);
});

test('with storage, a fatal that could not be sent is delivered on next launch', async () => {
  const storage = memoryStorage();
  globalThis.fetch = async () => {
    throw new TypeError('Network request failed');
  };
  init({ storage });
  installed(new Error('fatal while offline'), true);
  await tick(100);
  const saved = JSON.parse(storage.map.get('errtap:pending-fatal'));
  assert.match(saved.body, /fatal while offline/);

  const sent = [];
  globalThis.fetch = async (_url, req) => {
    sent.push(req);
    return { ok: true, status: 202 };
  };
  init({ storage }); // next launch
  await tick(50);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['Idempotency-Key'], saved.id, 'same key, so a copy that did land is stored once');
  assert.equal(storage.map.has('errtap:pending-fatal'), false);
});

test('circular or BigInt payloads never throw out of the error handler', async () => {
  order.length = 0;
  const bodies = [];
  globalThis.fetch = async (_url, req) => {
    bodies.push(req.body);
    return { ok: true, status: 202 };
  };
  init();
  const circular = { big: 10n };
  circular.self = circular;
  sdk.logger.info('breadcrumb with a cycle', circular);
  assert.doesNotThrow(() => installed(new Error('non-fatal'), false));
  assert.deepEqual(order, ['previous:false']);
  await tick(20);
  assert.ok(bodies.every((b) => typeof b === 'string'));
  assert.match(bodies.at(-1), /\[Circular\]/);
});

test('captureException accepts whatever was thrown', () => {
  globalThis.fetch = async () => ({ ok: true, status: 202 });
  init();
  for (const thrown of [null, undefined, 'text', 7]) assert.doesNotThrow(() => sdk.captureException(thrown));
});

test('fields are cut to the backend DTO caps so the event is not rejected', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, req) => {
    bodies.push(JSON.parse(req.body));
    return { ok: true, status: 202 };
  };
  init({ environment: 'e'.repeat(300) });
  sdk.logger.info('l'.repeat(10_000));
  sdk.captureException(new Error('m'.repeat(10_000)), { stacktrace: 's'.repeat(60_000), context: { big: 'c'.repeat(40 * 1024) } });
  // an unknown field the caps cannot trim forces the oversize fallback envelope
  sdk.captureMessage('f'.repeat(10_000), { extra: 'x'.repeat(300_000) });
  await tick(20);

  const [log, error, fallback] = bodies;
  assert.equal(log.message.length, 8192); // LogEventDto.message
  assert.equal(error.message.length, 2000); // ErrorEventDto.message
  assert.ok(error.stacktrace.length <= 50_000);
  assert.equal(error.context, undefined); // over the 32KB metadata cap
  assert.equal(fallback.truncated, true);
  assert.ok(fallback.message.length <= 2000);
  assert.ok(fallback.environment.length <= 100);
});

test('without TextEncoder, non-ASCII context is still measured in UTF-8 bytes', async () => {
  // Hermes before React Native 0.74 has no TextEncoder; counting .length there would let a
  // context of 12,000 CJK characters (36,000 bytes) through, and the backend would 400 it.
  const encoder = globalThis.TextEncoder;
  delete globalThis.TextEncoder;
  try {
    const bodies = [];
    globalThis.fetch = async (_url, req) => {
      bodies.push(JSON.parse(req.body));
      return { ok: true, status: 202 };
    };
    init();
    sdk.captureMessage('over', { context: { notes: '中'.repeat(12_000) } });
    // well under the cap: the SDK also adds breadcrumbs to context
    sdk.captureMessage('under', { context: { notes: '中'.repeat(4_000) } });
    await tick(20);
    assert.equal(bodies[0].context, undefined); // 36,000 bytes > 32KB
    assert.equal(bodies[1].context.notes.length, 4_000); // 12,000 bytes fits
  } finally {
    globalThis.TextEncoder = encoder;
  }
});
