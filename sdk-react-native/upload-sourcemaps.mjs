#!/usr/bin/env node
// Upload a React Native bundle's source map to ErrTap so production stack traces
// de-minify. Run it after you produce a release bundle + sourcemap, once per platform.
//
// Usage:
//   errtap-upload-sourcemaps --sourcemap <path> [--bundle <name>]
//
//   --sourcemap   path to the source map (REQUIRED). With Hermes this must be the
//                 *composed* map (Metro map composed with the Hermes bytecode map),
//                 or the columns won't line up with the runtime stack.
//   --bundle      the filename the runtime stack references, e.g. "index.android.bundle"
//                 or "main.jsbundle". Defaults to the sourcemap name minus ".map".
//
// Env:
//   ERRTAP_AUTH_TOKEN upload token (Project settings → Upload tokens) — a CI secret
//   ERRTAP_DSN        the project DSN — only used to find the host
//   ERRTAP_RELEASE    release tag — MUST equal the `release` you pass to init()
//   ERRTAP_ENDPOINT   ingest origin, required only for a bare-key DSN
//
// RN source maps are build artifacts (never shipped in the app / never served), so unlike
// the Next uploader this does NOT delete them.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const MAX_BYTES = 9.5 * 1024 * 1024; // backend caps the request body at 10MB; leave headroom

// Minimal DSN parse — enough to get the key + origin. (Can't import the SDK's resolveDsn:
// index.js imports 'react-native', which doesn't exist in a Node build environment.)
export function parseDsn(dsn, endpointOverride) {
  if (!dsn) return null;
  if (dsn.includes('@')) {
    try {
      const u = new URL(dsn);
      const key = decodeURIComponent(u.username);
      return key ? { key, origin: u.origin } : null;
    } catch {
      return null;
    }
  }
  if (!endpointOverride) return null;
  try {
    return { key: dsn, origin: new URL(endpointOverride).origin };
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sourcemap') out.sourcemap = argv[++i];
    else if (argv[i] === '--bundle') out.bundle = argv[++i];
  }
  return out;
}

// The map is stored under the .js/.bundle basename the runtime stack references.
export function bundleName(sourcemapPath, override) {
  return override || basename(sourcemapPath).replace(/\.map$/, '');
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const { sourcemap, bundle } = parseArgs(process.argv.slice(2));
  const dsn = process.env.ERRTAP_DSN;
  const release = process.env.ERRTAP_RELEASE;
  const token = process.env.ERRTAP_AUTH_TOKEN;

  if (!sourcemap) throw new Error('[errtap] --sourcemap <path> is required');
  if (!token || !dsn || !release) {
    console.warn('[errtap] set ERRTAP_AUTH_TOKEN, ERRTAP_DSN and ERRTAP_RELEASE to upload sourcemaps — skipping.');
    return;
  }

  const resolved = parseDsn(dsn, process.env.ERRTAP_ENDPOINT);
  if (!resolved) {
    throw new Error('[errtap] could not resolve DSN — use a URL DSN or set ERRTAP_ENDPOINT for a bare key');
  }

  const size = (await stat(sourcemap)).size;
  if (size > MAX_BYTES) {
    throw new Error(
      `[errtap] ${sourcemap} is ${(size / 1024 / 1024).toFixed(1)}MB — over the 10MB ingest limit. ` +
        'Split the bundle or raise the backend body limit.',
    );
  }

  const filename = bundleName(sourcemap, bundle);
  const map = await readFile(sourcemap, 'utf8');
  const uploadUrl = new URL('/ingest/sourcemaps', `${resolved.origin}/`).toString();

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ release, files: [{ filename, map }] }),
  });
  if (!res.ok) throw new Error(`[errtap] upload failed ${res.status}: ${await res.text()}`);

  console.log(`[errtap] uploaded sourcemap for "${filename}" under release "${release}".`);
}

function selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selftest failed: ${msg}`);
  };
  // bundle name defaults to sourcemap basename minus .map, override wins
  assert(bundleName('/build/index.android.bundle.map') === 'index.android.bundle', 'android default');
  assert(bundleName('ios/main.jsbundle.map') === 'main.jsbundle', 'ios default');
  assert(bundleName('/x/whatever.map', 'main.jsbundle') === 'main.jsbundle', 'override');
  // arg parsing
  const a = parseArgs(['--sourcemap', 'x.map', '--bundle', 'main.jsbundle']);
  assert(a.sourcemap === 'x.map' && a.bundle === 'main.jsbundle', 'args');
  // DSN parse: URL form and bare key
  assert(parseDsn('https://et_abc@errtap.example').key === 'et_abc', 'url dsn key');
  assert(parseDsn('https://et_abc@errtap.example').origin === 'https://errtap.example', 'url dsn origin');
  assert(parseDsn('et_abc', 'https://host:4000/ingest/error').origin === 'https://host:4000', 'bare key origin');
  assert(parseDsn('et_abc') === null, 'bare key needs endpoint');
  console.log('selftest ok');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
