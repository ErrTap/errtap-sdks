import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SDK = fileURLToPath(new URL('./index.js', import.meta.url));

// an ingest server that accepts the connection and never answers
async function hangingServer() {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function runChild(body, { port, flags = [] }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...flags, '--input-type=module', '-e', `
      import { init } from ${JSON.stringify(SDK)};
      init({ dsn: 'et_test', endpoint: 'http://127.0.0.1:${port}/ingest/error' });
      ${body}
    `]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr, ms: Date.now() - started }));
  });
}

test('an uncaught exception prints, reports, and exits 1 within the flush budget', async () => {
  const server = await hangingServer();
  try {
    const { code, stderr, ms } = await runChild(`setTimeout(() => { throw new Error('boom uncaught') })`, {
      port: server.address().port,
    });
    assert.equal(code, 1);
    assert.match(stderr, /boom uncaught/);
    assert.ok(ms < 6000, `exited after ${ms}ms, expected ~2s rather than a full retry cycle`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('an unhandled rejection is fatal, as it is in Node without the SDK', async () => {
  const server = await hangingServer();
  try {
    const { code, stderr } = await runChild(`Promise.reject(new Error('boom rejection'))`, { port: server.address().port });
    assert.equal(code, 1);
    assert.match(stderr, /boom rejection/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('--unhandled-rejections=warn keeps the process alive', async () => {
  const server = await hangingServer();
  try {
    const { code } = await runChild(`Promise.reject(new Error('boom warn')); setTimeout(() => process.exit(0), 200)`, {
      port: server.address().port,
      flags: ['--unhandled-rejections=warn'],
    });
    assert.equal(code, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
