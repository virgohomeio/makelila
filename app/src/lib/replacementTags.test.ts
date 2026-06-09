import { describe, it, expect } from 'vitest';
import { replacementItemTags, replacementStageTag } from './replacementTags';

const order = (line_items: unknown[], extra: Partial<{ awaiting_batch_id: string | null; replacement_state: string | null }> = {}) =>
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
