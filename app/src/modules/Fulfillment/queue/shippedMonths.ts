import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { ShippedMark } from '../../../lib/shippedOrders';

/** Bucketing for the Queue's Shipped tab.
 *
 *  Ready to ship is a work list — a handful of rows, ordered by what to pack
 *  next. Shipped is a hundred-plus rows of history, and ordering that by order
 *  ref gave an operator nothing to navigate by: #1002 and #1252 sit next to
 *  each other whether they went out in April or last week. Anyone opening this
 *  tab is looking something up, and what they remember about it is roughly
 *  when it shipped. So it reads newest-first, headed by month.
 */

/** When a shipped row's box actually left.
 *
 *  Two kinds of row land in this tab. One was walked to step 6 by hand and
 *  carries fulfilled_at. The other shipped some other way entirely — booked
 *  straight in Freightcom, picked off the shelf by someone who never opened
 *  the queue — and was never stamped at all; the evidence that moved it here
 *  (see lib/shippedOrders.ts) is the only thing that knows its date.
 *
 *  Nothing here falls back to created_at. That is when the row was *queued*,
 *  which on the stuck rows is months off — #1178 was queued 2026-06-05 against
 *  a machine delivered long before. A row with no date says so.
 */
export function shippedOn(
  row: FulfillmentQueueRow,
  mark?: ShippedMark | null,
): string | null {
  return row.fulfilled_at
    ?? mark?.shippedAt
    ?? mark?.deliveredAt
    ?? row.email_sent_at
    ?? row.dock_confirmed_at
    ?? row.label_confirmed_at
    ?? null;
}

/** Parse either shape that reaches this file as a LOCAL instant.
 *
 *  fulfilled_at is a full timestamptz; units.shipped_at is a bare date column,
 *  so a mark can carry "2026-07-01". `new Date("2026-07-01")` is UTC midnight,
 *  which is 30 June anywhere west of Greenwich — that would file a July
 *  shipment under June. Same trap parseLocalDate in QueueSidebar exists for.
 */
function parseShipped(value: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? (() => {
        const [y, m, day] = value.split('-').map(Number);
        return new Date(y, m - 1, day);
      })()
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ShippedMonthGroup = {
  /** Sort key: "2026-09", or '' for the undated bucket. */
  key: string;
  /** What the operator reads: "September 2026". */
  label: string;
  rows: FulfillmentQueueRow[];
};

const UNDATED_KEY = '';
const UNDATED_LABEL = 'Date unknown';

/** Shipped rows bucketed by the month they went out, newest month first and
 *  newest row first inside each. Rows whose date is not knowable keep their
 *  own bucket at the bottom rather than being guessed into a real month. */
export function groupShippedByMonth(
  rows: FulfillmentQueueRow[],
  shippedMarks?: Map<string, ShippedMark>,
): ShippedMonthGroup[] {
  const dated = rows.map(row => {
    const iso = shippedOn(row, shippedMarks?.get(row.id));
    const at = iso ? parseShipped(iso) : null;
    return { row, at };
  });

  const groups = new Map<string, ShippedMonthGroup & { at: number }>();
  for (const { row, at } of dated) {
    const key = at
      ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
      : UNDATED_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: at
          ? at.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
          : UNDATED_LABEL,
        rows: [],
        at: at ? at.getTime() : 0,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  // Newest first within a month. An undated row has nothing to sort on, so
  // those keep the order they arrived in.
  const timeOf = new Map(dated.map(d => [d.row.id, d.at ? d.at.getTime() : null]));
  for (const group of groups.values()) {
    group.rows.sort((a, b) => (timeOf.get(b.id) ?? 0) - (timeOf.get(a.id) ?? 0));
  }

  return Array.from(groups.values())
    .sort((a, b) => {
      // The undated bucket sinks below every real month, however old.
      if (a.key === UNDATED_KEY) return 1;
      if (b.key === UNDATED_KEY) return -1;
      return b.key.localeCompare(a.key);
    })
    .map(({ key, label, rows: groupRows }) => ({ key, label, rows: groupRows }));
}
