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
