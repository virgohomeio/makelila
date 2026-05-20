#!/usr/bin/env node
// Enforces byte-identical mirrors between supabase/functions/_shared/ files
// and their app/src/lib/ counterparts. We accept the duplication trade-off
// because edge-function deploys only see files under supabase/functions/,
// and Vitest can't easily reach that subtree without custom path config.
//
// Each pair must have ZERO imports of project-relative code so both Deno and
// Node can consume them. Add new pairs to MIRRORED_FILES below.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const MIRRORED_FILES = [
  ['app/src/lib/classifier.ts',   'supabase/functions/_shared/classifier.ts'],
  ['app/src/lib/quo-parsers.ts',  'supabase/functions/_shared/quo-parsers.ts'],
];

let failed = false;
for (const [mirror, canonical] of MIRRORED_FILES) {
  const a = readFileSync(resolve(repoRoot, mirror), 'utf8');
  const b = readFileSync(resolve(repoRoot, canonical), 'utf8');
  if (a === b) {
    console.log(`OK  ${mirror} == ${canonical}`);
  } else {
    console.error(`DRIFT  ${mirror} != ${canonical}`);
    console.error('       sync them (cp canonical → mirror) before committing.');
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
