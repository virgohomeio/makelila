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
  it('ready unit → Unit', () => {
    expect(replacementStageTag(order([], { replacement_state: 'ready' }), ['P100'])).toBe('Unit');
    expect(replacementStageTag(order([]), ['P150'])).toBe('Unit');
  });
  it('awaiting / batch-blocked unit → awaiting batch', () => {
    expect(replacementStageTag(order([], { awaiting_batch_id: 'P100X' }), ['P100X'])).toBe('awaiting batch');
    expect(replacementStageTag(order([], { replacement_state: 'awaiting' }), ['P100'])).toBe('awaiting batch');
  });
  it('parts only → Parts/Consumables', () => {
    expect(replacementStageTag(order([]), ['chamber-L', 'hopper'])).toBe('Parts/Consumables');
  });
  it('no tags → null', () => {
    expect(replacementStageTag(order([]), [])).toBeNull();
  });
});
