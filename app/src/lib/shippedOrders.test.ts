// A queue row whose machine is already at the customer must leave "Ready to
// ship". Every fixture below is a real row from the live queue on 2026-09-04.
import { describe, it, expect } from 'vitest';
import {
  markShippedForOrder,
  indexShippedQueueRows,
  shippedMarkTitle,
  type ShippedEvidence,
} from './shippedOrders';

/** The six sale orders that were stuck, plus the four that were genuinely
 *  waiting, plus the replacements — as the DB actually held them. */
const EVIDENCE: ShippedEvidence = {
  units: [
    { serial: 'LL01-00000000255', status: 'shipped', customer_order_ref: '#1169', shipped_at: '2026-06-05' },
    { serial: 'LL01-00000000309', status: 'shipped', customer_order_ref: '#1171', shipped_at: '2026-06-18' },
    { serial: 'LL01-00000000310', status: 'shipped', customer_order_ref: '#1172', shipped_at: '2026-06-04' },
    { serial: 'LL01-00000000252', status: 'shipped', customer_order_ref: '#1178', shipped_at: '2026-06-12' },
    { serial: 'LL01-00000000257', status: 'shipped', customer_order_ref: '#1180', shipped_at: '2026-06-12' },
    // Stamped with R-0005 — a replacement, which this module never acts on.
    { serial: 'LL01-00000000322', status: 'shipped', customer_order_ref: 'R-0005', shipped_at: '2026-04-23' },
    // Reserved against #1169 but never shipped: status is what decides.
    { serial: 'LL01-00000000302', status: 'reserved', customer_order_ref: '#1169', shipped_at: '2026-04-17' },
  ],
  shipments: [
    { order_id: 'o-1179', unit_serial: 'LL01-00000000315', booked_at: '2026-06-12', delivered_at: '2026-06-20' },
    // R-0027's bogus link: booked five months before the replacement existed.
    { order_id: 'o-r0027', unit_serial: 'LL01-00000000210', booked_at: '2026-03-12', delivered_at: '2026-03-14' },
  ],
};

const QUEUED_JUN_5 = '2026-06-05T14:00:00Z';

describe('markShippedForOrder', () => {
  it('marks an order whose unit is stamped with its ref', () => {
    const mark = markShippedForOrder(
      { id: 'o-1178', order_ref: '#1178', kind: 'sale' }, QUEUED_JUN_5, EVIDENCE);
    expect(mark).toEqual({
      basis: 'ref',
      serial: 'LL01-00000000252',
      shippedAt: '2026-06-12',
      deliveredAt: null,
    });
  });

  it('marks on the ref even when the unit shipped before the row was queued', () => {
    // #1172's machine went out 2026-06-04, a day before the queue row was
    // created. The stamp is order-level truth, so no date guard applies.
    const mark = markShippedForOrder(
      { id: 'o-1172', order_ref: '#1172', kind: 'sale' }, QUEUED_JUN_5, EVIDENCE);
    expect(mark?.basis).toBe('ref');
  });

  it('ignores a unit reserved against the order but not shipped', () => {
    // LL01-...302 carries ref #1169 at status 'reserved'. #1169 is still marked
    // shipped, but on LL01-...255 — the one that actually left.
    const mark = markShippedForOrder(
      { id: 'o-1169', order_ref: '#1169', kind: 'sale' }, QUEUED_JUN_5, EVIDENCE);
    expect(mark?.serial).toBe('LL01-00000000255');
  });

  it('matches refs that differ only in formatting', () => {
    const evidence: ShippedEvidence = {
      units: [{ serial: 'LL01-1', status: 'shipped', customer_order_ref: '1171', shipped_at: null }],
      shipments: [],
    };
    const mark = markShippedForOrder(
      { id: 'o-1171', order_ref: '#1171', kind: 'sale' }, QUEUED_JUN_5, evidence);
    expect(mark?.basis).toBe('ref');
  });

  it('marks an order whose shipment was booked after it was queued', () => {
    // #1179's unit carries no order ref, so only the shipment says it went.
    const mark = markShippedForOrder(
      { id: 'o-1179', order_ref: '#1179', kind: 'sale' }, QUEUED_JUN_5, EVIDENCE);
    expect(mark).toEqual({
      basis: 'in-queue',
      serial: 'LL01-00000000315',
      shippedAt: '2026-06-12',
      deliveredAt: '2026-06-20',
    });
  });

  it('ignores a shipment booked before the row was queued', () => {
    // The whole point of the date guard: an older shipment of the customer's,
    // attached to this order by a name match, is not evidence about this box.
    const mark = markShippedForOrder(
      { id: 'o-1179', order_ref: '#1179', kind: 'sale' }, '2026-07-01T00:00:00Z', EVIDENCE);
    expect(mark).toBeNull();
  });

  it('leaves an order with no shipped machine alone', () => {
    for (const ref of ['#1188', '#1189', '#1190', '#1214']) {
      expect(markShippedForOrder({ id: `o-${ref}`, order_ref: ref, kind: 'sale' }, QUEUED_JUN_5, EVIDENCE))
        .toBeNull();
    }
  });

  it('never marks a replacement, even with a stamped unit', () => {
    // R-0005's unit carries its ref and shipped 2026-04-23. Replacement
    // shipping data is not trustworthy enough to hide a row the picker needs.
    expect(markShippedForOrder(
      { id: 'o-r0005', order_ref: 'R-0005', kind: 'replacement' }, '2026-08-18T00:00:00Z', EVIDENCE))
      .toBeNull();
    expect(markShippedForOrder(
      { id: 'o-r0027', order_ref: 'R-0027', kind: 'replacement' }, '2026-08-19T00:00:00Z', EVIDENCE))
      .toBeNull();
  });

  it('treats missing evidence as "not shipped" rather than throwing', () => {
    expect(markShippedForOrder({ id: 'o-1', order_ref: '#1', kind: 'sale' }, QUEUED_JUN_5)).toBeNull();
    expect(markShippedForOrder(
      { id: 'o-1', order_ref: '#1', kind: 'sale' }, null,
      { units: [], shipments: [{ order_id: 'o-1', unit_serial: null, booked_at: '2026-06-01', delivered_at: null }] },
    )).toBeNull();
  });

  it('does not let a blank ref match a unit with no order ref', () => {
    const evidence: ShippedEvidence = {
      units: [{ serial: 'LL01-9', status: 'shipped', customer_order_ref: null, shipped_at: null }],
      shipments: [],
    };
    expect(markShippedForOrder({ id: 'o-x', order_ref: '', kind: 'sale' }, QUEUED_JUN_5, evidence)).toBeNull();
  });
});

describe('indexShippedQueueRows', () => {
  const rows = [
    { id: 'q-1169', order_id: 'o-1169', created_at: QUEUED_JUN_5 },
    { id: 'q-1179', order_id: 'o-1179', created_at: QUEUED_JUN_5 },
    { id: 'q-1188', order_id: 'o-1188', created_at: '2026-06-16T14:00:00Z' },
    { id: 'q-r0027', order_id: 'o-r0027', created_at: '2026-08-19T00:00:00Z' },
    { id: 'q-orphan', order_id: 'o-missing', created_at: QUEUED_JUN_5 },
  ];
  const orders = new Map(Object.entries({
    'o-1169': { id: 'o-1169', order_ref: '#1169', kind: 'sale' },
    'o-1179': { id: 'o-1179', order_ref: '#1179', kind: 'sale' },
    'o-1188': { id: 'o-1188', order_ref: '#1188', kind: 'sale' },
    'o-r0027': { id: 'o-r0027', order_ref: 'R-0027', kind: 'replacement' },
  }));

  it('keys the marks by queue row and skips everything still owed', () => {
    const marks = indexShippedQueueRows(rows, orders, EVIDENCE);
    expect([...marks.keys()].sort()).toEqual(['q-1169', 'q-1179']);
  });

  it('leaves a row alone when its order has not loaded yet', () => {
    // The queue fetches rows and orders separately; a row whose order is still
    // in flight must not be treated as shipped.
    expect(indexShippedQueueRows(rows, new Map(), EVIDENCE).size).toBe(0);
  });
});

describe('shippedMarkTitle', () => {
  it('names the machine and tells the operator what to do', () => {
    const title = shippedMarkTitle({
      basis: 'ref', serial: 'LL01-00000000252', shippedAt: '2026-06-12', deliveredAt: null,
    });
    expect(title).toContain('LL01-00000000252');
    expect(title).toContain('Do not pack a second one');
  });

  it('prefers the delivery date when there is one', () => {
    const title = shippedMarkTitle({
      basis: 'in-queue', serial: 'LL01-00000000315', shippedAt: '2026-06-12', deliveredAt: '2026-06-20',
    });
    expect(title).toContain('delivered 2026-06-20');
  });
});
