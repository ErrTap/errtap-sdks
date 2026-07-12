#!/usr/bin/env node
// Upload a Next.js build's browser sourcemaps to ErrTap, then delete them so the
// minified source isn't served publicly (the maps live on ErrTap for symbolication).
//
// Usage (as a postbuild step):  errtap-upload-sourcemaps [.next dir]
// Env:
//   ERRTAP_DSN | NEXT_PUBLIC_ERRTAP_DSN   the project DSN (URL form or bare key)
//   ERRTAP_RELEASE | NEXT_PUBLIC_ERRTAP_RELEASE | VERCEL_GIT_COMMIT_SHA   release tag
//   ERRTAP_ENDPOINT   ingest origin, required only for bare-key DSNs
//
// The release MUST match what the client SDK sends (NEXT_PUBLIC_ERRTAP_RELEASE), or
// events tagged with a different release won't find these maps and stay minified.

import { readdir, readFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { resolveDsn } from '@errtap/node';

const MAX_FILES = 50; // backend caps a batch at 50 files / 10MB body
const MAX_BYTES = 8 * 1024 * 1024; // headroom under the 10MB limit

// Split files into batches that fit the backend's 50-file / ~8MB limits.
// A single file larger than maxBytes still ships alone (the backend takes it up to 10MB).
export function planBatches(files, maxFiles = MAX_FILES, maxBytes = MAX_BYTES) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const f of files) {
    const size = Buffer.byteLength(f.map);
    if (cur.length && (cur.length >= maxFiles || bytes + size > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(p)));
    else if (entry.name.endsWith('.js.map')) found.push(p);
  }
  return found;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const dsn = process.env.ERRTAP_DSN || process.env.NEXT_PUBLIC_ERRTAP_DSN;
  const release =
    process.env.ERRTAP_RELEASE ||
    process.env.NEXT_PUBLIC_ERRTAP_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA;
  const arg = process.argv[2];
  const nextDir = arg && !arg.startsWith('-') ? arg : '.next';

  const staticDir = join(nextDir, 'static');
  const mapPaths = await walk(staticDir).catch(() => []);
  if (!mapPaths.length) {
    console.warn(`[errtap] no .js.map files under ${staticDir} — is productionBrowserSourceMaps enabled?`);
    return;
  }

  if (!dsn || !release) {
    await Promise.all(mapPaths.map((p) => unlink(p).catch(() => {})));
    console.warn(
      `[errtap] DSN/release missing — removed ${mapPaths.length} sourcemaps without uploading so source is not published.`,
    );
    return;
  }

  const resolved = resolveDsn(dsn, process.env.ERRTAP_ENDPOINT);
  if (!resolved) {
    throw new Error('[errtap] could not resolve DSN — use a URL DSN or set ERRTAP_ENDPOINT for a bare key');
  }
  const uploadUrl = new URL('/ingest/sourcemaps', resolved.endpoint).toString();

  const files = await Promise.all(
    mapPaths.map(async (p) => ({
      path: p,
      // Store under the .js basename — that's the key symbolication looks maps up by.
      filename: basename(p).replace(/\.map$/, ''),
      map: await readFile(p, 'utf8'),
    })),
  );

  let uploaded = 0;
  for (const batch of planBatches(files)) {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DSN ${resolved.key}` },
      body: JSON.stringify({ release, files: batch.map(({ filename, map }) => ({ filename, map })) }),
    });
    if (!res.ok) throw new Error(`[errtap] upload failed ${res.status}: ${await res.text()}`);
    uploaded += batch.length;
  }

  // Remove the maps from the build output so source isn't publicly served.
  await Promise.all(files.map((f) => unlink(f.path).catch(() => {})));
  console.log(`[errtap] uploaded ${uploaded} sourcemaps for release "${release}" and removed them from the build.`);
}

function selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selftest failed: ${msg}`);
  };
  const mk = (name, kb) => ({ filename: name, map: 'x'.repeat(kb * 1024) });

  // count cap: 120 tiny files -> 50 + 50 + 20
  const byCount = planBatches(Array.from({ length: 120 }, (_, i) => mk(`${i}.js`, 1)), 50, MAX_BYTES);
  assert(byCount.length === 3 && byCount[0].length === 50 && byCount[2].length === 20, 'count batching');

  // byte cap: two ~4.9MB files can't share an 8MB batch
  const byBytes = planBatches([mk('a.js', 5000), mk('b.js', 5000), mk('c.js', 100)], 50, MAX_BYTES);
  assert(byBytes.length === 2 && byBytes[0].length === 1 && byBytes[1].length === 2, 'byte batching');

  // an oversize single file still ships in its own batch
  const solo = planBatches([mk('big.js', 9000)], 50, MAX_BYTES);
  assert(solo.length === 1 && solo[0].length === 1, 'oversize solo');

  // filename key = .js basename, not .js.map
  assert(basename('/x/static/chunks/foo-abc123.js.map').replace(/\.map$/, '') === 'foo-abc123.js', 'filename key');

  console.log('selftest ok');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
