import { describe, it, expect } from 'vitest';
import { replacementItemTags, replacementStageTag, replacementDemandBySku, replacementUnitDemandByBatch, isUnitTag } from './replacementTags';

const order = (line_items: unknown[], extra: Partial<{ awaiting_batch_id: string | null; replacement_state: string | null; shipped_at: string | null; delivered_at: string | null }> = {}) =>
  ({ line_items, awaiting_batch_id: null, replacement_state: 'ready', ...extra }) as never;

describe('replacementItemTags', () => {
  it('maps structured part SKUs to the vocabulary', () => {
    expect(replacementItemTags(order([
      { kind: 'part', sku: 'LILA-CHAMBER-L' }, { kind: 'part', sku: 'LILA-HOPPER' },
    ]))).toEqual(['chamber-L', 'hopper']);
  });

  it('maps unit/unit_pending batches to unit tags', () => {
    expect(replacementItemTags(order([{ kind: 'unit', batch: 'P100' }]))).toEqual(['P100']);
    expect(replacementItemTags(order([{ kind: 'unit_pending', batch: 'P100X' }]))).toEqual(['P100X']);
  });

  it('parses the looser Excel-backfill descriptions', () => {
    expect(replacementItemTags(order([{ kind: 'part', description: 'both side latch' }]))).toEqual(['side latch-L', 'side latch-R']);
    expect(replacementItemTags(order([{ kind: 'part', description: 'broken compost chamber (right side)' }]))).toEqual(['chamber-R']);
    expect(replacementItemTags(order([{ kind: 'part', description: 'left side chamber' }]))).toEqual(['chamber-L']);
    expect(replacementItemTags(order([{ kind: 'part', description: 'starter bags' }]))).toEqual(['starter kit']);
    expect(replacementItemTags(order([{ kind: 'part', description: 'side latch (?) and filter cup' }]))).toEqual(['side latch', 'filter']);
  });

  it('folds in awaiting_batch_id when line_items has no unit (e.g. R-0032)', () => {
    expect(replacementItemTags(order([], { awaiting_batch_id: 'P100X' }))).toEqual(['P100X']);
  });
});

describe('replacementStageTag', () => {
  const isPending = (b: string) => b === 'P100X'; // P100X not yet arrived
  it('unit on an available batch → Unit', () => {
    expect(replacementStageTag(order([{ kind: 'unit', batch: 'P100' }]), ['P100'], isPending)).toBe('Unit');
    expect(replacementStageTag(order([{ kind: 'unit', batch: 'P150' }]), ['P150'], isPending)).toBe('Unit');
  });
  it('unit on a pending batch → awaiting batch (regardless of replacement_state)', () => {
    expect(replacementStageTag(order([], { awaiting_batch_id: 'P100X' }), ['P100X'], isPending)).toBe('awaiting batch');
    // free-text "P100 X" row imported as replacement_state='ready' still resolves correctly
    expect(replacementStageTag(order([{ kind: 'part', description: 'P100 X' }], { replacement_state: 'ready' }), ['P100X'], isPending)).toBe('awaiting batch');
  });
  it('parts only → Parts/Consumables', () => {
    expect(replacementStageTag(order([{ kind: 'part', sku: 'LILA-HOPPER' }]), ['chamber-L', 'hopper'], isPending)).toBe('Parts/Consumables');
  });
  it('unnamed parts (no vocab tag) still → Parts/Consumables', () => {
    expect(replacementStageTag(order([{ kind: 'part', description: 'unspecified parts' }]), [], isPending)).toBe('Parts/Consumables');
  });
  it('truly empty → null', () => {
    expect(replacementStageTag(order([]), [], isPending)).toBeNull();
  });
});

describe('replacementDemandBySku', () => {
  const o = (line_items: unknown[], extra: Record<string, unknown> = {}) =>
    ({ line_items, awaiting_batch_id: null, shipped_at: null, delivered_at: null, ...extra }) as Parameters<typeof replacementDemandBySku>[0][number];

  it('counts queued part demand by SKU from descriptions AND structured rows', () => {
    const m = replacementDemandBySku([
      o([{ kind: 'part', description: 'both side latch' }]),                 // L + R
      o([{ kind: 'part', description: 'Right side latch' }]),                // R
      o([{ kind: 'part', description: 'broken compost chamber (right side)' }]), // chamber-R
      o([{ kind: 'part', description: 'both compost chambers cracked' }]),   // chamber-L + R
      o([{ kind: 'part', description: 'left side chamber' }]),               // chamber-L
      o([{ kind: 'part', description: 'Replacement top lid' }]),             // lid
      o([{ kind: 'part_pending', sku: 'LILA-CHAMBER-L', part_id: 'P-CHAMBER-L' },
         { kind: 'part_pending', sku: 'LILA-CHAMBER-R', part_id: 'P-CHAMBER-R' }]), // L + R (structured)
    ]);
    expect(m.get('LILA-CHAMBER-L')).toBe(3);
    expect(m.get('LILA-CHAMBER-R')).toBe(3);
    expect(m.get('LILA-LATCH-SIDE-L')).toBe(1);
    expect(m.get('LILA-LATCH-SIDE-R')).toBe(2);
    expect(m.get('LILA-LID-V36')).toBe(1);
  });

  it('unit demand groups by batch and excludes parts/shipped', () => {
    const m = replacementUnitDemandByBatch([
      o([{ kind: 'unit_pending', batch: 'P150' }]),
      o([{ kind: 'unit_pending', batch: 'P150' }]),
      o([{ kind: 'unit_pending', batch: 'P100' }]),
      o([], { awaiting_batch_id: 'P100X' }),               // empty line_items, batch-blocked
      o([{ kind: 'part', description: 'P100 X' }]),         // free-text unit → P100X
      o([{ kind: 'part', description: 'both side latch' }]), // a part → not counted
      o([{ kind: 'unit_pending', batch: 'P100X' }], { shipped_at: '2026-06-01' }), // shipped → skip
    ]);
    expect(m.get('P150')).toBe(2);
    expect(m.get('P100')).toBe(1);
    expect(m.get('P100X')).toBe(2);
    expect(m.has('side latch-L')).toBe(false);
  });

  it('excludes shipped/delivered orders, units, ambiguous-side, and unspecified parts', () => {
    const m = replacementDemandBySku([
      o([{ kind: 'part', description: 'left side chamber' }], { shipped_at: '2026-06-01' }), // shipped → skip
      o([{ kind: 'unit_pending', batch: 'P100X' }]),            // unit → not a part
      o([{ kind: 'part', description: 'side latch (? side)' }]), // ambiguous → no SKU
      o([{ kind: 'part', description: 'unspecified parts' }]),   // no tag → nothing
    ]);
    expect(m.size).toBe(0);
  });
});

describe('LILA-Mini upcoming batch', () => {
  const isPending = (b: string) => b === 'P100X' || b === 'LILA-Mini'; // both not yet arrived

  it('LILA-Mini is a unit tag', () => {
    expect(isUnitTag('LILA-Mini')).toBe(true);
    expect(isUnitTag('lila-mini')).toBe(true);
    expect(isUnitTag('LILAMini')).toBe(true);
  });

  it('maps a LILA-Mini unit_pending line + awaiting_batch_id to the unit tag', () => {
    expect(replacementItemTags(order([{ kind: 'unit_pending', batch: 'LILA-Mini' }]))).toEqual(['LILA-Mini']);
    expect(replacementItemTags(order([], { awaiting_batch_id: 'LILA-Mini' }))).toEqual(['LILA-Mini']);
  });

  it('a LILA-Mini replacement reads as "awaiting batch" until the batch arrives', () => {
    expect(replacementStageTag(order([], { awaiting_batch_id: 'LILA-Mini' }), ['LILA-Mini'], isPending)).toBe('awaiting batch');
  });

  it('counts LILA-Mini toward per-batch unit demand', () => {
    const m = replacementUnitDemandByBatch([
      order([{ kind: 'unit_pending', batch: 'LILA-Mini' }]),
      order([], { awaiting_batch_id: 'LILA-Mini' }),
      order([{ kind: 'unit_pending', batch: 'LILA-Mini' }], { shipped_at: '2026-06-01' }), // shipped → skip
    ]);
    expect(m.get('LILA-Mini')).toBe(2);
  });
});
