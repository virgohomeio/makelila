# Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give makeLILA a single, enforced source of visual truth — a complete token set, a brand red that no longer collides with the error red, and a guardrail that stops the second palette creeping back — without changing any module's markup.

**Architecture:** Everything lands in `app/src/styles/tokens.css` plus two small Node scripts. No React changes, no module changes, no route changes. Because 1,646 `var(--token)` references already exist across the module CSS, the colour fix propagates app-wide the moment the token changes. The guardrail is a ratchet: it checks only files explicitly listed as migrated, so it can be added today and tightened as each module lands.

**Tech Stack:** CSS custom properties · Vitest 4 (jsdom, globals) · Node 24 ESM scripts, matching the existing `app/scripts/check-classifier-drift.mjs` pattern

**Spec:** [`docs/superpowers/specs/2026-08-19-frontend-redesign-design.md`](../specs/2026-08-19-frontend-redesign-design.md) §5.1–5.3, Phase 0

---

## Where this sits in the sequence

This is **plan 1 of many**. The spec's phases each get their own plan, written when the previous one lands, so later plans can absorb what earlier ones learned:

| Plan | Covers | Status |
|---|---|---|
| **1. Design system foundation** | Spec Phase 0 — tokens, colour fix, guardrail | **This document** |
| 2. UI primitives | Phase 1 — `components/ui/*` incl. `StageRail` | Not yet written |
| 3. Shell | Phase 2 — sidebar, ⌘K palette, route changes | Not yet written |
| 4. Pilot: Fulfillment | Phase 3 — includes the Shipping fold-in. **Review checkpoint.** | Not yet written |
| 5…14. One plan per module | Phase 4 — sequential, per operator constraint | Not yet written |
| 15. Role-aware home | Phase 5 | Not yet written |
| 16. Cleanup + mobile restyle | Phase 6 | Not yet written |

Nothing in this plan changes what any screen looks like except the two colour corrections in Task 2 and Task 4, both of which are deliberate.

---

## Constraint: no node builtins under `src/`

Learned the hard way while executing this plan; it applies to every later plan in the sequence.

`app/tsconfig.app.json` typechecks `include: ["src"]` with `types: ["vite/client"]`. **Anything under `app/src/` that imports `node:fs`, `node:path` or `node:url` fails `tsc -b`, and therefore fails `npm run build`,** even though Vitest runs it happily. No test in `src/` did this before this plan.

So a test under `src/` that needs to read a file must read it through Vite:

```ts
import tokensCss from './tokens.css?raw';
```

With one catch that costs an hour if you don't know it: **Vitest replaces `.css` imports with an empty string by default**, and that interception fires on the extension regardless of the `?raw` query. The import typechecks, the build passes, and the test silently receives `''`. The fix is a scoped entry in `vite.config.ts`:

```ts
test: {
  css: { include: [/tokens\.css/] },
}
```

Scoped deliberately — a bare `css: true` turns on real CSS processing for all 100+ test files to serve one.

This does **not** apply to `app/scripts/*.mjs` (Task 3 and Task 4). Those sit outside `include: ["src"]`, are never typechecked by `tsc -b`, and use `node:fs` correctly.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `app/src/styles/tokens.test.ts` | Asserts the token contract: required tokens exist, brand tokens are unchanged, spacing is a real scale, brand red and error red are distinguishable |
| `app/scripts/lib/find-raw-hex.mjs` | Pure function: given CSS source, return raw hex literals with line numbers, ignoring comments. No I/O — this is the testable core |
| `app/scripts/lib/find-raw-hex.test.mjs` | Unit tests for the above |
| `app/scripts/check-css-tokens.mjs` | Thin CLI over `find-raw-hex`. Owns the migrated-file list and the process exit code |

**Modified**

| File | Change |
|---|---|
| `app/src/styles/tokens.css` | Add type scale, spacing scale, mono font, elevation, row heights, focus ring; correct `--color-error` |
| `app/src/styles/globals.css` | `.replBadge` stops hardcoding hex so it can be the first guarded file |
| `app/package.json` | Add `check:css-tokens` script; run it from `build` |
| `app/vite.config.ts` | Scoped `test.css.include` so `tokens.test.ts` receives the real stylesheet |

The split between `find-raw-hex.mjs` and `check-css-tokens.mjs` is deliberate: file-system walking and `process.exit` are not unit-testable, string scanning is. Keep the pure part pure.

---

## Task 1: Token contract and the missing tokens

`tokens.css` today defines colour, two fonts, and four sizing values. Everything else — spacing, type sizes, shadows, row heights, focus rings — is improvised per module, which is half of why modules look different. This task adds the missing tokens and locks them behind a test.

**Files:**
- Create: `app/src/styles/tokens.test.ts`
- Modify: `app/src/styles/tokens.css`

- [ ] **Step 1: Write the failing test**

Create `app/src/styles/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// Read through Vite, NOT node:fs — see "Constraint: no node builtins under
// src/" below. Requires test.css.include in vite.config.ts, or Vitest hands
// back an empty string.
import tokensCss from './tokens.css?raw';

// tokens.css is the one file in the app allowed to hold raw hex values —
// every other stylesheet must reach them through var(). These tests are the
// contract that lets check-css-tokens.mjs enforce that rule elsewhere.
//
// The stylesheet is parsed by jsdom rather than scanned with a regex: a
// regex reports a token as "defined" even when it sits inside a comment or
// outside the :root block, which is exactly the silent failure this contract
// exists to prevent.
const style = document.createElement('style');
style.textContent = tokensCss;
document.head.appendChild(style);
const ROOT = getComputedStyle(document.documentElement);

function tokenValue(name: string): string | null {
  return ROOT.getPropertyValue(name).trim() || null;
}

const SPACING = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7'];

const REQUIRED = [
  '--font-mono',
  '--font-size-title', '--font-size-section', '--font-size-body', '--font-size-meta',
  ...SPACING,
  '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--row-height', '--row-height-header',
  '--focus-ring',
];

describe('tokens.css', () => {
  it.each(REQUIRED)('defines %s', (name) => {
    expect(tokenValue(name)).not.toBeNull();
  });

  it('leaves the LILA brand tokens untouched', () => {
    expect(tokenValue('--color-crimson')).toBe('#CC2D30');
    expect(tokenValue('--color-ink')).toBe('#2C2A25');
    expect(tokenValue('--font-logo')).toContain('Brolink');
  });

  it('spacing is a 4px-based ascending scale', () => {
    const px = SPACING.map((name) => parseInt(tokenValue(name) ?? '', 10));
    expect(px).toEqual([4, 8, 12, 16, 24, 32, 48]);
  });

  it('row height reflects the compact density decision', () => {
    expect(tokenValue('--row-height')).toBe('34px');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd app && npx vitest run src/styles/tokens.test.ts
```

Expected: FAIL — 20 of 21. The 18 `defines %s` cases fail with `expected null not to be null`; the spacing-scale and row-height cases fail on `NaN`. Only `leaves the LILA brand tokens untouched` passes, because those tokens already exist.

- [ ] **Step 3: Add the tokens**

In `app/src/styles/tokens.css`, immediately before the closing `}` of the `:root` block, append:

```css
  /* ── Typography scale ──────────────────────────────────────────────────
     Four sizes, no more. Anything that doesn't fit one of these is a sign
     the layout is wrong, not that the scale is short. */
  --font-size-title:   20px;  /* page title */
  --font-size-section: 15px;  /* section heading, card title */
  --font-size-body:    13px;  /* body copy, table cells */
  --font-size-meta:    11px;  /* uppercase labels, timestamps */

  /* Identifiers and quantities — order refs, serials, money, counts — are
     monospaced with tabular figures so digits align down a column. This is
     functional, not decorative: operators reconcile refunds by scanning. */
  --font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;

  /* ── Spacing ───────────────────────────────────────────────────────────
     4px base. Use these, never arbitrary pixel values. */
  --space-1:  4px;
  --space-2:  8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;

  /* ── Elevation ─────────────────────────────────────────────────────────
     Warm-tinted shadows so cards don't read cold against the cream page. */
  --shadow-sm: 0 1px 2px rgba(44, 42, 37, 0.06);
  --shadow-md: 0 4px 12px rgba(44, 42, 37, 0.10);
  --shadow-lg: 0 8px 24px rgba(44, 42, 37, 0.14);

  /* ── Table rows ────────────────────────────────────────────────────────
     Compact density (design decision, 2026-08-19): the cramped feeling is
     fixed by alignment and quieter borders, not by adding padding. Changing
     --row-height is the single lever if that turns out to be wrong. */
  --row-height:        34px;
  --row-height-header: 30px;

  /* ── Focus ─────────────────────────────────────────────────────────────
     One visible focus treatment everywhere. Keyboard access is a floor. */
  --focus-ring: 0 0 0 3px rgba(204, 45, 48, 0.28);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd app && npx vitest run src/styles/tokens.test.ts
```

Expected: PASS, 21 tests (18 `defines` cases + 3 others).

- [ ] **Step 5: Commit**

```bash
git add app/src/styles/tokens.css app/src/styles/tokens.test.ts
git commit -m "feat(design-system): add type, spacing, elevation, row and focus tokens

tokens.css defined colour and two fonts; everything else was improvised per
module, which is half of why no two modules look alike. Adds the missing
scales and a test that holds them to a contract.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Separate the error red from the brand red

`--color-crimson` is `#CC2D30`; `--color-error` is `#c53030`. Their relative-luminance ratio is **1.038** — to the eye, one colour. A destructive warning therefore carries exactly the weight of the primary call to action. `#7F1D1D` measures 1.90 against brand red and 10.02:1 against white, so it stays strong as badge text.

**Files:**
- Modify: `app/src/styles/tokens.test.ts`
- Modify: `app/src/styles/tokens.css:22`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('tokens.css', …)` block in `app/src/styles/tokens.test.ts`:

```ts
  // WCAG relative luminance. Used here to prove two reds are actually
  // different, not to assert a text-contrast requirement.
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function ratio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  it('error red is clearly distinguishable from brand red', () => {
    const brand = tokenValue('--color-crimson');
    const error = tokenValue('--color-error');
    expect(brand).not.toBeNull();
    expect(error).not.toBeNull();
    expect(ratio(brand as string, error as string)).toBeGreaterThanOrEqual(1.7);
  });

  it('error red stays legible as text on white', () => {
    expect(ratio('#ffffff', tokenValue('--color-error') as string)).toBeGreaterThanOrEqual(7);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd app && npx vitest run src/styles/tokens.test.ts -t 'distinguishable'
```

Expected: FAIL — `expected 1.0379… to be greater than or equal to 1.7`.

- [ ] **Step 3: Change the token**

In `app/src/styles/tokens.css`, replace the `--color-error` line:

```css
  --color-error: #7F1D1D;
```

Replace the comment above the Status block so the reasoning survives:

```css
  /* Status.
     --color-error is deliberately much deeper than Ladybug Red. The two were
     #CC2D30 and #c53030 — a 1.038 luminance ratio, i.e. the same colour — so
     a destructive warning looked exactly like a primary action. Ladybug Red
     now means "action" and nothing else. See tokens.test.ts. */
```

- [ ] **Step 4: Run the full token suite and confirm it passes**

```bash
cd app && npx vitest run src/styles/tokens.test.ts
```

Expected: PASS, 23 tests.

- [ ] **Step 5: Check nothing depended on the old value visually**

```bash
cd app && npx vitest run && npm run build
```

Expected: the existing suite is green and the build succeeds. `--color-error` is referenced through `var()`, so no consumer needs editing.

- [ ] **Step 6: Commit**

```bash
git add app/src/styles/tokens.css app/src/styles/tokens.test.ts
git commit -m "fix(design-system): stop error red impersonating the brand red

#CC2D30 and #c53030 sit at a 1.038 luminance ratio — the same colour to the
eye — so destructive warnings carried the weight of a primary action.
--color-error becomes #7F1D1D: 1.90 against brand red, 10.02:1 on white.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The raw-hex detector

The pure, testable core of the guardrail. It must ignore hex inside comments — `tokens.css` and several module files document colours in prose — and must report accurate line numbers so the message is actionable.

**Files:**
- Create: `app/scripts/lib/find-raw-hex.mjs`
- Create: `app/scripts/lib/find-raw-hex.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `app/scripts/lib/find-raw-hex.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { findRawHex } from './find-raw-hex.mjs';

describe('findRawHex', () => {
  it('finds a hex literal in a declaration', () => {
    expect(findRawHex('.a { color: #718096; }')).toEqual([{ line: 1, hex: '#718096' }]);
  });

  it('ignores hex inside a block comment', () => {
    expect(findRawHex('/* was #718096 */\n.a { color: var(--color-ink); }')).toEqual([]);
  });

  it('keeps line numbers accurate after a multi-line comment', () => {
    const css = [
      '/* palette notes',
      '   old value #4a5568',
      '   replaced 2026-08 */',
      '.a { color: #e2e8f0; }',
    ].join('\n');
    expect(findRawHex(css)).toEqual([{ line: 4, hex: '#e2e8f0' }]);
  });

  it('finds every literal on a line, in order', () => {
    expect(findRawHex('.a { color: #fff; background: #F5F1EB; }')).toEqual([
      { line: 1, hex: '#fff' },
      { line: 1, hex: '#F5F1EB' },
    ]);
  });

  // globals.css contains '#app-shell' at lines 43 and 70. 'p' is not a hex
  // digit, so it cannot satisfy the 3-char minimum and is never flagged.
  it('does not flag an ID selector like #app-shell', () => {
    expect(findRawHex('#app-shell { overflow: visible; }')).toEqual([]);
  });

  it('returns nothing for a file that only uses tokens', () => {
    expect(findRawHex('.a { color: var(--color-ink); border: 1px solid var(--color-border); }')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd app && npx vitest run scripts/lib/find-raw-hex.test.mjs
```

Expected: FAIL — `Failed to resolve import "./find-raw-hex.mjs"`.

- [ ] **Step 3: Write the implementation**

Create `app/scripts/lib/find-raw-hex.mjs`:

```js
// Pure string scanning for the CSS token guardrail. Deliberately free of any
// I/O so it can be unit-tested; check-css-tokens.mjs owns files and exit codes.
//
// This is a string scanner, not a CSS tokenizer, so it has no notion of
// string literals: `content: "/*"` will blank live code that follows it,
// and `content: "#fff"` will be flagged as a colour literal. Neither
// pattern exists in this codebase today; a real tokenizer was judged not
// worth the complexity for a build-time guardrail.

/**
 * Finds raw hex colour literals in CSS source, ignoring anything inside
 * block comments.
 *
 * @param {string} css
 * @returns {{ line: number, column: number, hex: string }[]} hits in document order
 */
export function findRawHex(css) {
  // Declared per call, not at module scope: matchAll never mutates lastIndex
  // so a shared regex is safe today, but a shared /g regex is a landmine for
  // whoever next reaches for .test()/.exec() here. Longest alternative
  // first reads as the obvious, unsurprising order — the trailing \b means a
  // shorter branch that swallowed part of a longer run fails anyway (both
  // sides of the cut are still "word" characters), so this is defence in
  // depth rather than a fix for an observed bug.
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

  // Blank comments out rather than deleting them, for two reasons: (1)
  // newlines are preserved, so reported line numbers still match the file
  // the developer will open, and (2) it prevents code that only becomes
  // contiguous once the comment is gone from being read as one token — e.g.
  // `#ab/*z*/cdef` must never be reported as the fabricated literal
  // `#abcdef`, which deleting the comment outright would produce.
  // An unterminated `/*` blanks to end of string rather than failing to
  // match at all: the CSS spec treats EOF as closing an open comment, so
  // whatever follows is already dead and must not be scanned.
  const scannable = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (block) => block.replace(/[^\n]/g, ' '));

  const hits = [];
  scannable.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(hex)) {
      hits.push({ line: index + 1, column: match.index + 1, hex: match[0] });
    }
  });
  return hits;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd app && npx vitest run scripts/lib/find-raw-hex.test.mjs
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/scripts/lib/find-raw-hex.mjs app/scripts/lib/find-raw-hex.test.mjs
git commit -m "feat(design-system): add raw-hex detector for the CSS guardrail

Pure, I/O-free scanner. Blanks comments rather than stripping them so
reported line numbers match the file on disk.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The guardrail CLI, and its first guarded file

A ratchet, not a big-bang cleanup. It checks only files named in `MIGRATED`, which starts as one file and grows as each module lands. The 1,099 existing violations stay legal until their module's turn — the rule is simply that they can never come back.

`globals.css` is the first entry, and it needs one fix to qualify: `.replBadge` hardcodes `#fef3c7` and `#b7791f`. Mapping those onto the warning tokens shifts the badge very slightly — that is the intended consistency change, not an accident.

**Files:**
- Create: `app/scripts/check-css-tokens.mjs`
- Modify: `app/src/styles/globals.css:108-109`
- Modify: `app/package.json:8,14`

- [ ] **Step 1: Write the CLI**

Create `app/scripts/check-css-tokens.mjs`:

```js
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
];

let failed = false;

for (const relativePath of MIGRATED) {
  const hits = findRawHex(readFileSync(resolve(appRoot, relativePath), 'utf8'));
  if (hits.length === 0) continue;

  failed = true;
  console.error(`\n${relativePath} — ${hits.length} raw hex value(s), expected var(--token):`);
  for (const { line, column, hex } of hits) {
    console.error(`  ${relativePath}:${line}:${column}  ${hex}`);
  }
}

if (failed) {
  console.error('\nDefine the colour in src/styles/tokens.css and reference it with var().\n');
  process.exit(1);
}

console.log(`check:css-tokens — ${MIGRATED.length} file(s) clean`);
```

- [ ] **Step 2: Run it and confirm it fails on the real violation**

```bash
cd app && node scripts/check-css-tokens.mjs
```

Expected: exit 1, reporting two hits in `src/styles/globals.css` — `#fef3c7` and `#b7791f` on the `.replBadge` rule.

- [ ] **Step 3: Fix `.replBadge` to use tokens**

In `app/src/styles/globals.css`, replace the two hardcoded lines inside `.replBadge`:

```css
  background: var(--color-warning-bg);
  color: var(--color-warning);
```

- [ ] **Step 4: Run it again and confirm it passes**

```bash
cd app && node scripts/check-css-tokens.mjs
```

Expected: exit 0, `check:css-tokens — 1 file(s) clean`.

- [ ] **Step 5: Wire it into package.json**

In `app/package.json`, add to `"scripts"`:

```json
    "check:css-tokens": "node scripts/check-css-tokens.mjs",
```

and make `build` run it, so a regression cannot reach production:

```json
    "build": "node scripts/check-css-tokens.mjs && tsc -b && vite build && node scripts/spa-fallback.mjs",
```

- [ ] **Step 6: Verify the whole thing end to end**

```bash
cd app && npm run check:css-tokens && npx vitest run && npm run build
```

Expected: the guardrail prints `1 file(s) clean`, the full Vitest suite is green, and the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/scripts/check-css-tokens.mjs app/src/styles/globals.css app/package.json
git commit -m "feat(design-system): ratchet CSS colour through tokens, starting with globals

Files listed in MIGRATED must use var(--token) instead of raw hex; each
module joins the list in the commit that migrates it. The ~1,099 literals in
unmigrated module CSS stay legal — they just can't come back.

.replBadge is the first fix: it hardcoded #fef3c7/#b7791f and now uses the
warning tokens, which shifts the badge very slightly. That is the intended
consistency change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- [ ] `npx vitest run` is green, including the token-contract and detector suites (47 tests between them as shipped)
- [ ] `npm run check:css-tokens` exits 0
- [ ] `npm run build` succeeds with the guardrail in the chain
- [ ] Error badges across the app now read visibly deeper than primary buttons — spot-check Fulfillment's queue and any refund view with `npm run dev`
- [ ] No module markup changed

## Notes for whoever picks this up

- **Do not bulk-replace the 1,099 hex literals.** They come out module by module in later plans. A sweeping find-and-replace would touch 29 files at once, which is exactly the overwhelm the sequential migration exists to avoid.
- **`tokens.css` must never appear in `MIGRATED`.** It is the one file allowed raw hex.
- **Known limitation of the detector:** an ID selector whose name is entirely hex-like — `#abc123` — would be reported as a colour. None exists today (`#app-shell`, the only ID in `globals.css`, is safe because `p` is not a hex digit). If one is ever added, exclude it in the CLI rather than loosening the regex.
- **If compact rows turn out to be wrong,** change `--row-height`. That is the whole change. The shipped assertion is a range (`<= 40px`, and greater than `--row-height-header`), not an equality, so the lever moves without test churn.
