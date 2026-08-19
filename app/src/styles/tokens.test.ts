import { describe, it, expect } from 'vitest';
import tokensCss from './tokens.css?raw';

// tokens.css is the one file in the app allowed to hold raw hex values —
// every other stylesheet must reach them through var(). This test loads the
// stylesheet into jsdom and reads tokens back through getComputedStyle,
// rather than regex-scanning the source text: a regex can't distinguish a
// live declaration from one sitting inside a comment or placed outside the
// :root block — both invisible to a real browser, but "defined" as far as a
// regex is concerned. getComputedStyle sees exactly what a browser would,
// which is the contract check-css-tokens.mjs relies on to enforce
// var()-only usage everywhere else in the app. The stylesheet comes in via
// Vite's `?raw` import (typed by vite/client, already in
// tsconfig.app.json's `types`) rather than node:fs, so this file needs no
// Node globals; vite.config.ts scopes `test.css.include` to this one file
// so the real bytes make it through Vitest's default CSS-to-empty-string
// mock — see the comment there.
const style = document.createElement('style');
style.textContent = tokensCss;
document.head.appendChild(style);
const ROOT = getComputedStyle(document.documentElement);

function tokenValue(name: string): string | null {
  return ROOT.getPropertyValue(name).trim() || null;
}

const SPACING = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7'];

const REQUIRED = [
  '--font-mono', '--font-numeric',
  '--font-size-title', '--font-size-section', '--font-size-body', '--font-size-meta',
  ...SPACING,
  '--color-crimson-rgb', '--color-ink-rgb', '--color-error-accent',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--row-height', '--row-height-header',
  '--focus-ring',
];

describe('tokens.css', () => {
  it('reads the real stylesheet, not Vitest\'s empty-string CSS mock', () => {
    // Diagnostic, not correctness: if test.css.include in vite.config.ts
    // ever stops matching tokens.css, tokensCss becomes '', jsdom parses
    // nothing, and every `defines %s` assertion below fails at once. That
    // simultaneous failure doesn't point at the cause — it looks like every
    // token vanished from tokens.css, and the Vitest CSS mock is the last
    // place anyone would look. This assertion fails first, alone, and names
    // the actual cause.
    expect(tokensCss.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED)('defines %s', (name) => {
    expect(tokenValue(name)).not.toBeNull();
  });

  it('leaves the LILA brand tokens untouched', () => {
    expect(tokenValue('--color-crimson')).toBe('#CC2D30');
    expect(tokenValue('--color-ink')).toBe('#2C2A25');
    expect(tokenValue('--font-logo')).toContain('Brolink');
  });

  it('spacing is a 4px-based, strictly ascending scale with no duplicates', () => {
    const raw = SPACING.map((name) => tokenValue(name));
    raw.forEach((value) => expect(value).toMatch(/^\d+px$/));

    const px = raw.map((value) => parseInt(value as string, 10));
    px.forEach((value) => expect(value % 4).toBe(0));
    for (let i = 1; i < px.length; i++) {
      expect(px[i]).toBeGreaterThan(px[i - 1]);
    }
    expect(new Set(px).size).toBe(px.length);
  });

  it('row height is compact and taller than the header row', () => {
    const row = parseInt(tokenValue('--row-height') as string, 10);
    const header = parseInt(tokenValue('--row-height-header') as string, 10);
    expect(row).toBeLessThanOrEqual(40);
    expect(row).toBeGreaterThan(header);
  });

  it('focus ring is derived from the crimson channels, not restated', () => {
    // Defined-ness of --color-crimson-rgb is covered by the REQUIRED loop
    // above; this checks the other half of the link — that --focus-ring
    // actually references it via var() rather than hardcoding the numbers,
    // so the two can't quietly drift apart. No trailing ")" on the needle:
    // a defensive fallback form like var(--color-crimson-rgb, 204, 45, 48)
    // should still satisfy this check.
    expect(tokenValue('--focus-ring')).toContain('var(--color-crimson-rgb');
  });

  // Both this and luminance() below need a hex string's channels; extracted
  // so a future fix (e.g. supporting 3-digit hex) has one place to land.
  // Assumes 6-digit hex — a 3-digit token like #fff yields NaN and fails
  // loudly rather than false-passing, which is fine as-is.
  const channelsOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  const channels = (hex: string) => channelsOf(hex).join(',');

  it.each(['--color-crimson', '--color-ink'])('%s-rgb matches its hex', (name) => {
    // jsdom returns "204,45,48" — commas without spaces — so normalise
    // whitespace before comparing.
    expect(tokenValue(`${name}-rgb`)!.replace(/\s+/g, '')).toBe(channels(tokenValue(name)!));
  });

  it.each(['--shadow-sm', '--shadow-md', '--shadow-lg'])('%s derives from the ink channels', (n) => {
    // Only --focus-ring was checked against --color-crimson-rgb before this;
    // without this, renaming --color-ink-rgb would leave all three shadows
    // pointing at a dead variable (invalid at computed-value time in a real
    // browser, so cards silently lose elevation) while every test still passes.
    expect(tokenValue(n)).toContain('var(--color-ink-rgb)');
  });

  // WCAG relative luminance.
  function luminance(hex: string): number {
    const [r, g, b] = channelsOf(hex).map((c) => c / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // Compares lightness, not hue — --color-info #2b6cb0 measures 1.029
  // against brand red yet is obviously distinguishable by hue alone. Used
  // here specifically to prove two REDS differ, where hue can't do the work.
  function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  it('error red is a different weight of red from brand red', () => {
    const brand = tokenValue('--color-crimson');
    const error = tokenValue('--color-error');
    expect(brand).not.toBeNull();
    expect(error).not.toBeNull();
    // 1.7 floor; #7F1D1D achieves 1.90 — headroom, not a ceiling
    expect(contrastRatio(brand as string, error as string)).toBeGreaterThanOrEqual(1.7);
  });

  it('error red stays legible as text on white', () => {
    // 7:1 = WCAG AAA for normal text
    expect(contrastRatio('#ffffff', tokenValue('--color-error') as string)).toBeGreaterThanOrEqual(7);
  });

  it('error red stays legible as text on --color-page', () => {
    // --color-page is the app's page background, but AppShell.tsx paints
    // <main> with a literal #fff, so white is also a real content surface —
    // both get checked. 7:1 = WCAG AAA for normal text.
    expect(contrastRatio(tokenValue('--color-page') as string, tokenValue('--color-error') as string)).toBeGreaterThanOrEqual(7);
  });

  it('error-strong stays AA-legible as text on white', () => {
    // --color-error-strong is NOT held to the 1.7 separation invariant above
    // — it's the vivid fill/accent variant and deliberately shares red's
    // family with the brand (see the Status comment block in tokens.css).
    // What it must hold is WCAG AA for normal text (4.5:1), because it's
    // used as text — buttons, badges — on light surfaces, not only as a fill.
    expect(contrastRatio('#ffffff', tokenValue('--color-error-strong') as string)).toBeGreaterThanOrEqual(4.5);
  });

  it('error-accent clears 3:1 against --color-dark-1', () => {
    // --color-error-accent is the vivid dark-surface sibling of
    // --color-error-strong (see the Status comment block in tokens.css) —
    // used for non-text elements like the queue sidebar's 3px left-border
    // markers, so the WCAG floor here is 3:1, not the 4.5:1 text floor.
    // This is the invariant that was silently violated when
    // --color-error-strong was darkened for AA-on-white and kept reused on
    // dark surfaces: it measured 2.27 against --color-dark-1, a fail.
    expect(contrastRatio(tokenValue('--color-error-accent') as string, tokenValue('--color-dark-1') as string)).toBeGreaterThanOrEqual(3);
  });
});
