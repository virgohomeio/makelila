import { describe, it, expect } from 'vitest';
import {
  PICKUP_STEP,
  goorooshipSend,
  indexGoorooshipSends,
  isAwaitingPickup,
  pickupBadgeTitle,
  splitAwaitingPickup,
  type GoorooshipSend,
  type PickupQueueRow,
} from './pickupQueue';
import { EZTRANS_SENT_ACTION } from './eztrans';
import { EZTRANS_BATCH_SENT_ACTION } from './eztransBatch';

function mkRow(p: Partial<PickupQueueRow> & { id: string; order_id: string }): PickupQueueRow {
  return { step: PICKUP_STEP, label_confirmed_at: '2026-09-29T20:00:00Z', ...p };
}

const NO_SENDS = new Map<string, GoorooshipSend>();

describe('indexGoorooshipSends', () => {
  it('maps both send types onto the order they name', () => {
    const m = indexGoorooshipSends([
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_SENT_ACTION,       entity_id: 'o1' },
      { ts: '2026-09-30T17:56:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o2' },
    ]);
    expect(m.get('o1')).toEqual({ at: '2026-09-29T20:12:00Z', via: 'booking' });
    expect(m.get('o2')).toEqual({ at: '2026-09-30T17:56:00Z', via: 'batch' });
  });

  it('keeps the latest send when an order was mailed twice', () => {
    // #1184's booking went three times on 2026-09-21. The last one is the one
    // the 3PL is working from.
    const m = indexGoorooshipSends([
      { ts: '2026-09-21T19:03:00Z', type: EZTRANS_SENT_ACTION, entity_id: 'o1' },
      { ts: '2026-09-21T21:10:00Z', type: EZTRANS_SENT_ACTION, entity_id: 'o1' },
      { ts: '2026-09-21T20:01:00Z', type: EZTRANS_SENT_ACTION, entity_id: 'o1' },
    ]);
    expect(m.get('o1')?.at).toBe('2026-09-21T21:10:00Z');
  });

  it('ignores unrelated log types and rows with no order behind them', () => {
    const m = indexGoorooshipSends([
      { ts: '2026-09-29T20:12:00Z', type: 'fq_eztrans_batch_confirmed', entity_id: 'o1' },
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_SENT_ACTION, entity_id: null },
    ]);
    expect(m.size).toBe(0);
  });
});

describe('goorooshipSend', () => {
  it('reads the day-batch stamp straight off the row', () => {
    const row = mkRow({ id: 'q1', order_id: 'o1', eztrans_batch_sent_at: '2026-09-30T17:56:34Z' });
    expect(goorooshipSend(row, NO_SENDS)).toEqual({ at: '2026-09-30T17:56:34Z', via: 'batch' });
  });

  it('falls back to the log for a pre-batch per-order send', () => {
    // The five rows at step 4 on 2026-09-30 that were mailed the old way: the
    // column is null on every one of them and only the log knows.
    const row = mkRow({ id: 'q1', order_id: 'o1', eztrans_batch_sent_at: null });
    const sends = new Map<string, GoorooshipSend>([['o1', { at: '2026-09-29T20:12:00Z', via: 'booking' }]]);
    expect(goorooshipSend(row, sends)?.via).toBe('booking');
  });

  it('is null when the 3PL has not been told', () => {
    expect(goorooshipSend(mkRow({ id: 'q1', order_id: 'o1' }), NO_SENDS)).toBeNull();
  });
});

describe('isAwaitingPickup', () => {
  const sends = new Map<string, GoorooshipSend>([['o1', { at: '2026-09-29T20:12:00Z', via: 'booking' }]]);

  it('moves a dock-handoff row whose label is confirmed and whose email went', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1' }), sends)).toBe(true);
  });

  it('leaves a row that has not reached the dock handoff', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 3 }), sends)).toBe(false);
  });

  it('leaves a row whose box has already gone', () => {
    // Step 5 is the customer shipping email: the carrier has been and gone.
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 5 }), sends)).toBe(false);
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 6 }), sends)).toBe(false);
  });

  it('leaves a rewound row whose label is no longer confirmed', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', label_confirmed_at: null }), sends)).toBe(false);
  });

  it('leaves a dock row the 3PL has never been told about', () => {
    // A machine picked off our own floor never gets a Goorooship email, and it
    // is still ours to chase — so it stays in the work list.
    expect(isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9' }), sends)).toBe(false);
  });
});

describe('splitAwaitingPickup', () => {
  it('moves rather than copies, and keeps the incoming order', () => {
    const sends = new Map<string, GoorooshipSend>([['o2', { at: '2026-09-29T20:12:00Z', via: 'booking' }]]);
    const a = mkRow({ id: 'q1', order_id: 'o1', step: 1, label_confirmed_at: null });
    const b = mkRow({ id: 'q2', order_id: 'o2' });
    const c = mkRow({ id: 'q3', order_id: 'o3', step: 3, label_confirmed_at: null });
    const { ready, pickup } = splitAwaitingPickup([a, b, c], sends);
    expect(ready.map(r => r.id)).toEqual(['q1', 'q3']);
    expect(pickup.map(r => r.id)).toEqual(['q2']);
    expect(ready.length + pickup.length).toBe(3);
  });
});

describe('pickupBadgeTitle', () => {
  it('names which of the two emails carried the carton', () => {
    expect(pickupBadgeTitle({ at: '2026-09-30T17:56:34Z', via: 'batch' })).toMatch(/day batch/i);
    expect(pickupBadgeTitle({ at: '2026-09-29T20:12:00Z', via: 'booking' })).toMatch(/own booking email/i);
  });
});
