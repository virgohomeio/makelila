import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tokens.css is the one file in the app allowed to hold raw hex values —
// every other stylesheet must reach them through var(). These tests are the
// contract that lets check-css-tokens.mjs enforce that rule elsewhere.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
);

function tokenValue(name: string): string | null {
  const match = CSS.match(new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm'));
  return match ? match[1].trim() : null;
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
