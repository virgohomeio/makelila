import { describe, it, expect } from 'vitest';
import { groupShippedByMonth, shippedOn } from '../queue/shippedMonths';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { ShippedMark } from '../../../lib/shippedOrders';

function mkRow(partial: Partial<FulfillmentQueueRow> & { id: string }): FulfillmentQueueRow {
  return {
    order_id: 'o1', step: 6, assigned_serial: null,
    test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
    carrier: null, tracking_num: null, label_pdf_path: null,
    label_confirmed_at: null, label_confirmed_by: null,
    dock_printed: false, dock_affixed: false, dock_docked: false,
    dock_notified: false, dock_picked_up: false,
    dock_confirmed_at: null, dock_confirmed_by: null,
    starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
    fulfilled_at: null, fulfilled_by: null,
    due_date: null, priority: false, created_at: '2026-01-02T00:00:00Z',
    ...partial,
  };
}

const refMark = (shippedAt: string | null, deliveredAt: string | null = null): ShippedMark =>
  ({ basis: 'ref', serial: 'LL01-00000000252', shippedAt, deliveredAt });

describe('shippedOn', () => {
  it('uses fulfilled_at for a row walked to step 6', () => {
    expect(shippedOn(mkRow({ id: 'q1', fulfilled_at: '2026-06-20T14:00:00Z' }))).toBe('2026-06-20T14:00:00Z');
  });

  // A row that shipped outside the queue never got stamped — the evidence that
  // put it under Shipped is the only thing that knows when the box went out.
  it('falls back to the shipped-mark date when the row was never stamped', () => {
    const row = mkRow({ id: 'q2', step: 1 });
    expect(shippedOn(row, refMark('2026-06-12'))).toBe('2026-06-12');
  });

  it('uses the delivery date when the mark carries no ship date', () => {
    const row = mkRow({ id: 'q3', step: 1 });
    expect(shippedOn(row, refMark(null, '2026-06-20'))).toBe('2026-06-20');
  });

  it('falls back to the shipping email before giving up', () => {
    expect(shippedOn(mkRow({ id: 'q4', email_sent_at: '2026-05-04T09:00:00Z' })))
      .toBe('2026-05-04T09:00:00Z');
  });

  // A closed-case replacement has no ship date anywhere. created_at is when the
  // row was *queued*, which is not when anything shipped — so say nothing.
  it('returns null rather than guessing from created_at', () => {
    const row = mkRow({ id: 'q5', step: 1, created_at: '2026-08-01T00:00:00Z' });
    const closed: ShippedMark = { basis: 'ticket-closed', serial: null, shippedAt: null, deliveredAt: null };
    expect(shippedOn(row, closed)).toBeNull();
  });
});

describe('groupShippedByMonth', () => {
  it('puts the most recent month first', () => {
    const groups = groupShippedByMonth([
      mkRow({ id: 'old', fulfilled_at: '2026-04-02T10:00:00Z' }),
      mkRow({ id: 'new', fulfilled_at: '2026-09-02T10:00:00Z' }),
      mkRow({ id: 'mid', fulfilled_at: '2026-06-02T10:00:00Z' }),
    ]);
    expect(groups.map(g => g.label)).toEqual(['September 2026', 'June 2026', 'April 2026']);
  });

  it('puts the most recent shipment first inside a month', () => {
    const groups = groupShippedByMonth([
      mkRow({ id: 'first', fulfilled_at: '2026-06-02T10:00:00Z' }),
      mkRow({ id: 'last', fulfilled_at: '2026-06-28T10:00:00Z' }),
      mkRow({ id: 'middle', fulfilled_at: '2026-06-15T10:00:00Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.id)).toEqual(['last', 'middle', 'first']);
  });

  it('groups rows shipped in the same month together', () => {
    const groups = groupShippedByMonth([
      mkRow({ id: 'a', fulfilled_at: '2026-06-02T10:00:00Z' }),
      mkRow({ id: 'b', fulfilled_at: '2026-06-28T10:00:00Z' }),
      mkRow({ id: 'c', fulfilled_at: '2026-07-01T10:00:00Z' }),
    ]);
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([
      ['July 2026', 1],
      ['June 2026', 2],
    ]);
  });

  it('reads a shipped-mark row into the month its box went out', () => {
    const stuck = mkRow({ id: 'stuck', step: 1, fulfilled_at: null });
    const groups = groupShippedByMonth(
      [stuck, mkRow({ id: 'walked', fulfilled_at: '2026-09-02T10:00:00Z' })],
      new Map([['stuck', refMark('2026-06-12')]]),
    );
    expect(groups.map(g => g.label)).toEqual(['September 2026', 'June 2026']);
    expect(groups[1].rows.map(r => r.id)).toEqual(['stuck']);
  });

  // units.shipped_at is a date column, so it arrives bare. new Date("2026-07-01")
  // is UTC midnight = 30 June anywhere west of Greenwich, which would file a
  // July shipment under June. Same trap parseLocalDate exists for.
  it('reads a bare YYYY-MM-DD as a local calendar month', () => {
    const groups = groupShippedByMonth(
      [mkRow({ id: 'firstOfMonth', step: 1 })],
      new Map([['firstOfMonth', refMark('2026-07-01')]]),
    );
    expect(groups.map(g => g.label)).toEqual(['July 2026']);
  });

  it('sinks rows with no known ship date to the bottom, under their own heading', () => {
    const groups = groupShippedByMonth([
      mkRow({ id: 'dated', fulfilled_at: '2026-04-02T10:00:00Z' }),
      mkRow({ id: 'undated', step: 1 }),
    ]);
    expect(groups.map(g => g.label)).toEqual(['April 2026', 'Date unknown']);
    expect(groups[1].rows.map(r => r.id)).toEqual(['undated']);
  });

  it('returns nothing for an empty tab', () => {
    expect(groupShippedByMonth([])).toEqual([]);
  });
});
