import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tokens.css is the one file in the app allowed to hold raw hex values —
// every other stylesheet must reach them through var(). This test loads the
// stylesheet into jsdom and reads tokens back through getComputedStyle,
// rather than regex-scanning the source text: a regex can't distinguish a
// live declaration from one sitting inside a comment or placed outside the
// :root block — both invisible to a real browser, but "defined" as far as a
// regex is concerned. getComputedStyle sees exactly what a browser would,
// which is the contract check-css-tokens.mjs relies on to enforce
// var()-only usage everywhere else in the app.
const style = document.createElement('style');
style.textContent = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);
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
  '--color-crimson-rgb', '--color-ink-rgb',
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
    // so the two can't quietly drift apart.
    expect(tokenValue('--focus-ring')).toContain('var(--color-crimson-rgb)');
  });

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
});
