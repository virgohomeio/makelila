#!/usr/bin/env node
// Guards the design-system migration. Every stylesheet listed in MIGRATED
// must express colour through var(--token) — never a raw hex literal.
//
// This is a RATCHET. The ~1,099 hex literals still sitting in unmigrated
// module CSS are legal until that module's turn; they simply may not come
// back once it has landed. Add a file here in the same commit that migrates
// it. tokens.css is intentionally absent: it is where the hexes live.
//
// Follows the same shape as check-classifier-drift.mjs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRawHex } from './lib/find-raw-hex.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIGRATED = [
  'src/styles/globals.css',
  'src/modules/OrderReview/OrderReview.module.css',
];

let failed = false;
let hadHexHits = false;

for (const relativePath of MIGRATED) {
  let source;
  try {
    source = readFileSync(resolve(appRoot, relativePath), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    failed = true;
    console.error(`\n${relativePath} is listed in MIGRATED but does not exist — was it renamed?`);
    continue;
  }

  const hits = findRawHex(source);
  if (hits.length === 0) continue;

  failed = true;
  hadHexHits = true;
  console.error(`\n${relativePath} — ${hits.length} raw hex value(s), expected var(--token):`);
  for (const { line, column, hex } of hits) {
    console.error(`  ${relativePath}:${line}:${column}  ${hex}`);
  }
}

if (failed) {
  if (hadHexHits) {
    console.error('\nDefine the colour in src/styles/tokens.css and reference it with var().\n');
  }
  process.exit(1);
}

console.log(`check:css-tokens — ${MIGRATED.length} file(s) clean`);
