#!/usr/bin/env node
// Guarantees app/src/lib/classifier.ts and
// supabase/functions/_shared/classifier.ts stay byte-identical. Run from CI
// or before committing changes to either copy.
//
// The classifier is dependency-free pure TS so both Deno (edge function) and
// Vitest can consume the same logic. We accept the duplication trade-off
// because edge-function deploys only see files under supabase/functions/ and
// reaching across that boundary at build time would mean a custom build step.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const mirror = resolve(repoRoot, 'app/src/lib/classifier.ts');
const canonical = resolve(repoRoot, 'supabase/functions/_shared/classifier.ts');

const a = readFileSync(mirror, 'utf8');
const b = readFileSync(canonical, 'utf8');

if (a === b) {
  console.log('classifier OK: app/src/lib/classifier.ts == supabase/functions/_shared/classifier.ts');
  process.exit(0);
}

console.error('classifier DRIFT detected.');
console.error('  mirror   : app/src/lib/classifier.ts');
console.error('  canonical: supabase/functions/_shared/classifier.ts');
console.error('Sync them (cp canonical → mirror) before committing.');
process.exit(1);
