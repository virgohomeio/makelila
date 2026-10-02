import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./activityLog', () => ({ logAction: vi.fn() }));

import { effectiveDemandBySku, parsePartFieldInput, suggestPartId } from './parts';

describe('effectiveDemandBySku', () => {
  it('keeps the derived count where no override is set', () => {
    const m = effectiveDemandBySku(new Map([['LILA-LID-V36', 3]]), [
      { sku: 'LILA-LID-V36', demand_override: null },
    ]);
    expect(m.get('LILA-LID-V36')).toBe(3);
  });

  it('replaces the derived count with the override, including 0', () => {
    const m = effectiveDemandBySku(new Map([['A', 3], ['B', 2]]), [
      { sku: 'A', demand_override: 7 },
      { sku: 'B', demand_override: 0 },
    ]);
    expect(m.get('A')).toBe(7);
    expect(m.get('B')).toBe(0);
  });

  it('adds SKUs that only have an override, and tolerates the column being absent', () => {
    const m = effectiveDemandBySku(new Map(), [
      { sku: 'LILA-TOTE', demand_override: 5 },
      { sku: 'LILA-MAGNET' },
    ]);
    expect(m.get('LILA-TOTE')).toBe(5);
    expect(m.has('LILA-MAGNET')).toBe(false);
  });
});

describe('parsePartFieldInput', () => {
  it('accepts whole non-negative counts', () => {
    expect(parsePartFieldInput('on_hand', '32')).toBe(32);
    expect(parsePartFieldInput('reorder_point', ' 0 ')).toBe(0);
  });

  it('rejects negatives, decimals and junk for counts', () => {
    expect(parsePartFieldInput('on_hand', '-1')).toBeUndefined();
    expect(parsePartFieldInput('on_hand', '1.5')).toBeUndefined();
    expect(parsePartFieldInput('demand_override', 'abc')).toBeUndefined();
  });

  it('blank clears demand and cost but not counts', () => {
    expect(parsePartFieldInput('demand_override', '')).toBeNull();
    expect(parsePartFieldInput('cost_per_unit_usd', '  ')).toBeNull();
    expect(parsePartFieldInput('on_hand', '')).toBeUndefined();
    expect(parsePartFieldInput('reorder_point', '')).toBeUndefined();
  });

  it('parses cost with an optional $ and up to 2 decimals', () => {
    expect(parsePartFieldInput('cost_per_unit_usd', '$24.50')).toBe(24.5);
    expect(parsePartFieldInput('cost_per_unit_usd', '4')).toBe(4);
    expect(parsePartFieldInput('cost_per_unit_usd', '4.555')).toBeUndefined();
  });
});

describe('suggestPartId', () => {
  it('prefixes by category and strips the LILA- vendor prefix', () => {
    expect(suggestPartId('consumable', 'LILA-TOTE', [])).toBe('C-TOTE');
    expect(suggestPartId('replacement', 'LILA-LID-V36', [])).toBe('P-LID-V36');
  });

  it('normalises spaces and punctuation', () => {
    expect(suggestPartId('consumable', 'fridge magnet (2in)', [])).toBe('C-FRIDGE-MAGNET-2IN');
  });

  it('suffixes rather than colliding with an existing id', () => {
    expect(suggestPartId('consumable', 'LILA-TOTE', ['C-TOTE'])).toBe('C-TOTE-2');
    expect(suggestPartId('consumable', 'LILA-TOTE', ['C-TOTE', 'C-TOTE-2'])).toBe('C-TOTE-3');
  });

  it('falls back to a usable id when the SKU has nothing alphanumeric', () => {
    expect(suggestPartId('replacement', '///', [])).toBe('P-PART');
  });
});
