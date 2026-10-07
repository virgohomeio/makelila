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
import { REBOOK_ACTION } from './rebookShipment';

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

  // Rebooking cancels the carrier booking AND the email that announced it.
  it('retires a send the order has since been rebooked out of', () => {
    const m = indexGoorooshipSends([
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o1' },
      { ts: '2026-10-01T09:00:00Z', type: REBOOK_ACTION,             entity_id: 'o1' },
    ]);
    expect(m.has('o1')).toBe(false);
  });

  it('keeps the send that followed the rebook — the new carton was mailed', () => {
    const m = indexGoorooshipSends([
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o1' },
      { ts: '2026-10-01T09:00:00Z', type: REBOOK_ACTION,             entity_id: 'o1' },
      { ts: '2026-10-01T17:40:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o1' },
    ]);
    expect(m.get('o1')).toEqual({ at: '2026-10-01T17:40:00Z', via: 'batch' });
  });

  it('retires only the rebooked order, not everything in the same batch', () => {
    const m = indexGoorooshipSends([
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o1' },
      { ts: '2026-09-29T20:12:00Z', type: EZTRANS_BATCH_SENT_ACTION, entity_id: 'o2' },
      { ts: '2026-10-01T09:00:00Z', type: REBOOK_ACTION,             entity_id: 'o1' },
    ]);
    expect(m.has('o1')).toBe(false);
    expect(m.get('o2')?.at).toBe('2026-09-29T20:12:00Z');
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

  // The log is keyed by order, not by queue row, and a queue row can be newer
  // than the order's last send. #1189 was booked to Goorooship on 2026-09-22,
  // shipped, then sent back to be reshipped — which deletes the queue row — and
  // re-confirmed on 2026-10-01, minting a fresh row. That September email was
  // about the first carton; it has been collected and delivered. Read onto the
  // new row it would park the reship under "To be picked up" the moment a label
  // was confirmed, badged GOOROOSHIP NOTIFIED, with nobody having told the 3PL
  // anything about the second box.
  //
  // A send can only concern a carton whose row already existed when it went, so
  // one older than the row is about a carton that is no longer this one.
  it('ignores a send that predates the queue row — it was a previous carton', () => {
    const row = mkRow({
      id: 'q-new', order_id: 'o-1189',
      eztrans_batch_sent_at: null, created_at: '2026-10-01T18:17:22Z',
    });
    const sends = new Map<string, GoorooshipSend>([
      ['o-1189', { at: '2026-09-22T19:08:49Z', via: 'booking' }],
    ]);
    expect(goorooshipSend(row, sends)).toBeNull();
    expect(isAwaitingPickup(row, sends)).toBe(false);
  });

  it('keeps a send made after the row was created — that is this carton', () => {
    const row = mkRow({
      id: 'q1', order_id: 'o1',
      eztrans_batch_sent_at: null, created_at: '2026-09-23T20:56:16Z',
    });
    const sends = new Map<string, GoorooshipSend>([
      ['o1', { at: '2026-09-29T19:57:05Z', via: 'booking' }],
    ]);
    expect(goorooshipSend(row, sends)?.at).toBe('2026-09-29T19:57:05Z');
  });

  // The row's own stamp is about the row by construction, so it is never
  // second-guessed on a date.
  it('still trusts the row stamp even if it somehow predates the row', () => {
    const row = mkRow({
      id: 'q1', order_id: 'o1',
      eztrans_batch_sent_at: '2026-09-20T10:00:00Z', created_at: '2026-10-01T18:17:22Z',
    });
    expect(goorooshipSend(row, NO_SENDS)?.via).toBe('batch');
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

  // Step 5 was excluded until 2026-10-01, on the reasoning that the carrier
  // had been and gone by then. It put #1194 and #1266 back in the picker's
  // work list with nothing left to pack — the rail runs to fulfilment now.
  it('keeps a row whose box has gone but whose customer email has not', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 5 }), sends)).toBe(true);
  });

  it('leaves a fulfilled row to the Shipped rail', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 6 }), sends)).toBe(false);
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', step: 7 }), sends)).toBe(false);
  });

  it('leaves a rewound row whose label is no longer confirmed', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q1', order_id: 'o1', label_confirmed_at: null }), sends)).toBe(false);
  });

  it('leaves an EZ Trans row the 3PL has never been told about', () => {
    // EZ Trans does not touch a box they have not been emailed about, so the
    // carton is still ours to chase and stays in the work list.
    expect(isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9' }), sends)).toBe(false);
  });

  // The email is a condition only for the rows it exists for. Stock picked off
  // our own floor books through Freightcom and EZ Trans is never emailed about
  // it — holding those back would have left every Freightcom carton in Ready
  // to ship for ever once its label was confirmed.
  it('moves a Freightcom row on the label alone', () => {
    expect(isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9' }), sends, () => false)).toBe(true);
  });

  it('still asks the Freightcom row for the rest of the rule', () => {
    const notEzTrans = () => false;
    expect(isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9', step: 3 }), sends, notEzTrans)).toBe(false);
    expect(isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9', step: 6 }), sends, notEzTrans)).toBe(false);
    expect(
      isAwaitingPickup(mkRow({ id: 'q2', order_id: 'o9', label_confirmed_at: null }), sends, notEzTrans),
    ).toBe(false);
  });

  // The caller's answer comes off a query, and before it returns the two wrong
  // answers are not symmetric: a carton parked under "To be picked up" with no
  // email behind it is the one nobody chases.
  it('requires the email when nobody says whether the row is EZ Trans', () => {
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

  it('sorts an EZ Trans carton and a Freightcom one by different rules', () => {
    const sends = new Map<string, GoorooshipSend>();
    const ez = mkRow({ id: 'q1', order_id: 'o1' });
    const ours = mkRow({ id: 'q2', order_id: 'o2' });
    const { ready, pickup } = splitAwaitingPickup([ez, ours], sends, r => r.id === 'q1');
    expect(ready.map(r => r.id)).toEqual(['q1']);
    expect(pickup.map(r => r.id)).toEqual(['q2']);
  });
});

describe('pickupBadgeTitle', () => {
  it('names which of the two emails carried the carton', () => {
    expect(pickupBadgeTitle({ at: '2026-09-30T17:56:34Z', via: 'batch' })).toMatch(/day batch/i);
    expect(pickupBadgeTitle({ at: '2026-09-29T20:12:00Z', via: 'booking' })).toMatch(/own booking email/i);
  });

  // The rail holds both halves of the handoff, so the badge must not tell an
  // operator a carton is awaiting collection days after the dock was confirmed.
  it('says what the row is actually waiting on, by step', () => {
    const send = { at: '2026-09-29T20:12:00Z', via: 'booking' } as const;
    expect(pickupBadgeTitle(send, 4)).toMatch(/waiting on the carrier/i);
    expect(pickupBadgeTitle(send, 5)).toMatch(/collected/i);
    expect(pickupBadgeTitle(send, 5)).not.toMatch(/waiting on the carrier/i);
  });
});
