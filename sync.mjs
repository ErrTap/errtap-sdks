#!/usr/bin/env node
// Generate the published single-file SDKs from the shared source in sdk/sdk-js.
// PUBLISHING.md requires dependency-free tarballs (no build step at install
// time), so this is codegen, not a package dependency: edit sdk/sdk-js, then
//   node sdk/sync.mjs          # rewrite the generated files
//   node sdk/sync.mjs --check  # exit 1 if a generated file is stale (CI)
// @errtap/react-native stays hand-written — its send pipeline intentionally
// diverges (platform tags, per-event context); the backend parity spec guards
// its resolveDsn copy.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = dirname(fileURLToPath(import.meta.url));

const HEADER = `// GENERATED FILE — do not edit. Source: sdk/sdk-js (core.js + %GLUE%).
// Regenerate with: node sdk/sync.mjs
`;

const TARGETS = [
  { glue: 'browser.js', out: 'sdk-js-browser/index.js' },
  { glue: 'node.js', out: 'sdk-node/index.js' },
];

function generate(glueFile) {
  const core = readFileSync(join(SDK, 'sdk-js/core.js'), 'utf8')
    // configure connects the shared entrypoint sources; published packages do
    // not expose it as a supported application API.
    .replace('export function configure(', 'function configure(');
  const glue = readFileSync(join(SDK, 'sdk-js', glueFile), 'utf8')
    // core is concatenated above — drop the import and the re-export of core's own exports
    .replace(/^import .* from '\.\/core\.js';\n/m, '')
    .replace(/^export \{[^}]*\};\n/m, '');
  return `${HEADER.replace('%GLUE%', glueFile)}\n${core.trimEnd()}\n\n${glue.trimStart()}`;
}

const check = process.argv.includes('--check');
let stale = 0;

for (const { glue, out } of TARGETS) {
  const next = generate(glue);
  const outPath = join(SDK, out);
  const current = readFileSync(outPath, 'utf8');
  if (current === next) continue;
  if (check) {
    console.error(`stale: sdk/${out} — run \`node sdk/sync.mjs\``);
    stale++;
  } else {
    writeFileSync(outPath, next);
    console.log(`wrote sdk/${out}`);
  }
}

if (check && stale) process.exit(1);
if (!stale) console.log(check ? 'generated SDKs are in sync' : 'done');
