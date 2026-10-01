import { useMemo, useState } from 'react';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { Order, OrderStatus } from '../../../lib/orders';
import { replacementItemTags } from '../../../lib/replacementTags';
import { refundFlagLabel, refundFlagTitle, type RefundFlag } from '../../../lib/refundedOrders';
import { shippedMarkLabel, shippedMarkTitle, type ShippedMark } from '../../../lib/shippedOrders';
import {
  goorooshipSend, pickupBadgeTitle, PICKUP_BADGE_LABEL, type GoorooshipSend,
} from '../../../lib/pickupQueue';
import { groupShippedByMonth } from './shippedMonths';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '../../../components/ui';
import styles from '../Fulfillment.module.css';

/** What the row needs to name a replacement. The queue is mostly sales, where
 *  "LILA Pro" says everything; a replacement can be a whole machine or a $24
 *  lid, and the two are picked, packed and shipped nothing alike. */
export type QueueOrderSummary = {
  order_ref: string;
  customer_name: string;
  city: string;
  country: 'US' | 'CA';
  status?: OrderStatus;
  kind?: 'sale' | 'replacement';
  line_items?: Order['line_items'];
  awaiting_batch_id?: string | null;
};

/** "lid", "hopper", "P100X" — the same vocabulary Fulfillment > Replacements
 *  uses, so the two surfaces name the same box the same way. Falls back to no
 *  suffix rather than inventing one when the line items say nothing useful. */
function replacementBadgeLabel(o: QueueOrderSummary): string {
  const tags = replacementItemTags({
    line_items: o.line_items ?? [],
    awaiting_batch_id: o.awaiting_batch_id ?? null,
  });
  return tags.length > 0 ? `Replacement · ${tags.join(', ')}` : 'Replacement';
}

/** Parse a "YYYY-MM-DD" due-date as a LOCAL calendar date (not UTC midnight).
 *  Browsers parse `new Date("2026-04-20")` as UTC, which is off by a day in
 *  negative-UTC timezones — so "Due TODAY" could display as "OVERDUE by 1d". */
function parseLocalDate(dueDate: string): Date {
  const [y, m, d] = dueDate.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function daysUntil(dueDate: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = parseLocalDate(dueDate); due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

function dueClass(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return `${styles.rowDue} ${styles.done}`;
  if (!dueDate) return styles.rowDue;
  const days = daysUntil(dueDate);
  if (days < 0) return `${styles.rowDue} ${styles.today}`;
  if (days === 0) return `${styles.rowDue} ${styles.today}`;
  if (days <= 2) return `${styles.rowDue} ${styles.soon}`;
  return `${styles.rowDue} ${styles.ok}`;
}

function dueLabel(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return '✓ Fulfilled';
  if (!dueDate) return '—';
  const days = daysUntil(dueDate);
  if (days < 0) return `⏰ OVERDUE by ${Math.abs(days)}d`;
  if (days === 0) return '⏰ Due TODAY';
  return `⏰ Due in ${days}d`;
}

/** Does this row answer the operator's search?
 *
 *  What the operator has in hand is a name off an email, or the order ref off
 *  an invoice — so both match, and the ref matches with or without its leading
 *  "#" (the series is written "#1188" here and "1188" nearly everywhere else).
 */
function matchesQuery(o: QueueOrderSummary | undefined, needle: string): boolean {
  if (!needle) return true;
  const hay = [o?.customer_name ?? '', o?.order_ref ?? '', (o?.order_ref ?? '').replace(/^#/, '')];
  return hay.some(h => h.toLowerCase().includes(needle));
}

/** The three rails, in the order the work moves through them. */
type Tab = 'ready' | 'pickup' | 'shipped';

const TAB_LABEL: Record<Tab, string> = {
  ready: 'Ready to ship',
  pickup: 'To be picked up',
  shipped: 'Shipped',
};

/** What a row in each rail *is*, for the "nothing matched" line. Written as a
 *  noun rather than the tab name so the sentence reads. */
const TAB_NOUN: Record<Tab, string> = {
  ready: 'order ready to ship',
  pickup: 'order waiting to be picked up',
  shipped: 'shipped order',
};

/** The search box's accessible name per rail. Spelled out rather than built
 *  from TAB_NOUN — "Search order ready to ships" is what composing it gets
 *  you, and this string is the only name a screen reader ever hears. */
const TAB_SEARCH_LABEL: Record<Tab, string> = {
  ready: 'Search orders ready to ship',
  pickup: 'Search orders waiting to be picked up',
  shipped: 'Search shipped orders',
};

export function QueueSidebar({
  readyRows,
  pickupRows = [],
  shippedRows,
  orderLookup,
  selectedId,
  onSelect,
  refundFlags,
  shippedMarks,
  goorooshipSends,
}: {
  readyRows: FulfillmentQueueRow[];
  /** Labelled, docked, and already emailed to Goorooship — waiting on the
   *  carrier rather than on us. See lib/pickupQueue.ts. Optional so a caller
   *  that has no notion of the third rail still renders the other two. */
  pickupRows?: FulfillmentQueueRow[];
  shippedRows: FulfillmentQueueRow[];
  orderLookup: Map<string, QueueOrderSummary>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Orders with a refund against them, by order id. A queued order whose money
   *  has gone back must not be picked, and the picker works from this rail. */
  refundFlags?: Map<string, RefundFlag>;
  /** Queue rows whose machine already went out, keyed by queue row id. These
   *  sit under Shipped rather than Ready to ship, and say why. */
  shippedMarks?: Map<string, ShippedMark>;
  /** When the 3PL was told about each order, by order id. Only read to explain
   *  a pickup row's badge — the rails themselves are split by the caller. */
  goorooshipSends?: Map<string, GoorooshipSend>;
}) {
  const [tab, setTab] = useState<Tab>('ready');
  // One query, both tabs. Looking a customer up usually starts as "is their
  // machine still on the floor?" and ends as "no — when did it go out?", so
  // the query survives the tab switch instead of making you retype it.
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const needle = query.trim().toLowerCase();

  const filter = (rs: FulfillmentQueueRow[]) =>
    needle ? rs.filter(r => matchesQuery(orderLookup.get(r.order_id), needle)) : rs;
  const matchedReady = useMemo(
    () => filter(readyRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readyRows, orderLookup, needle],
  );
  const matchedPickup = useMemo(
    () => filter(pickupRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickupRows, orderLookup, needle],
  );
  const matchedShipped = useMemo(
    () => filter(shippedRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shippedRows, orderLookup, needle],
  );
  const matched: Record<Tab, FulfillmentQueueRow[]> = {
    ready: matchedReady, pickup: matchedPickup, shipped: matchedShipped,
  };
  const population: Record<Tab, FulfillmentQueueRow[]> = {
    ready: readyRows, pickup: pickupRows, shipped: shippedRows,
  };
  const rows = matched[tab];
  // Ready to ship is a work list and stays in pick order. Shipped is history:
  // month headings, newest first. See ./shippedMonths.
  const shippedGroups = useMemo(
    () => groupShippedByMonth(matchedShipped, shippedMarks),
    [matchedShipped, shippedMarks],
  );
  // The tab counts stay on the whole population, never the match — they are
  // how you see how much the search is hiding. A search that finds nothing
  // here but something next door is the common case (the operator is looking
  // for a customer, not for a rail), so name the rail that has them.
  const elsewhere = (['ready', 'pickup', 'shipped'] as Tab[])
    .filter(t => t !== tab && matched[t].length > 0);
  // "1 match under Shipped, 2 under To be picked up." — the noun rides on the
  // first clause only, so a miss that turns up in two rails still reads as a
  // sentence rather than as a table.
  const elsewhereLine = elsewhere
    .map((t, i) => {
      const n = matched[t].length;
      const noun = i === 0 ? ` match${n === 1 ? '' : 'es'}` : '';
      return `${n}${noun} under ${TAB_LABEL[t]}`;
    })
    .join(', ') + '.';

  function renderRow(r: FulfillmentQueueRow) {
    const o = orderLookup.get(r.order_id);
    const shippedMark = shippedMarks?.get(r.id) ?? null;
    // A row that is no longer owed a box reads as done even though its
    // step never got there — otherwise it lands in Shipped still shouting
    // "OVERDUE by 91d" about a box the customer has had since June.
    const fulfilled = r.step === 6 || !!shippedMark;
    const overdue = !fulfilled && r.due_date && new Date(r.due_date) < new Date(new Date().setHours(0,0,0,0));
    const paused = !fulfilled && o?.status && o.status !== 'approved';
    const cls = [
      styles.queueRow,
      r.id === selectedId ? styles.selected : '',
      overdue ? styles.overdue : '',
      // Only fade as fulfilled in the ready tab (where they'd appear mixed in);
      // in the shipped tab every row is fulfilled so no need to de-emphasise.
      fulfilled && tab === 'ready' ? styles.fulfilled : '',
      r.priority && !fulfilled ? styles.priority : '',
      paused ? styles.paused : '',
    ].filter(Boolean).join(' ');
    const refundFlag = refundFlags?.get(r.order_id) ?? null;
    // Only in its own rail: under Ready to ship or Shipped the badge would be
    // noise on every row, and in the pickup rail it is the whole reason the
    // row is there — so it says which email went, and when.
    const pickupSend = tab === 'pickup' && goorooshipSends
      ? goorooshipSend(r, goorooshipSends)
      : null;
    const pauseBadge = paused
      ? (o?.status === 'flagged' ? '⚑ FLAGGED' : o?.status === 'held' ? '⏸ HELD' : '• PAUSED')
      : null;
    return (
      <div key={r.id} className={cls} onClick={() => onSelect(r.id)} role="button" tabIndex={0}>
        <div className={styles.rowName}>
          {r.priority && !fulfilled && <span className={styles.priorityBadge} title="Priority — expedite">⭐</span>}
          {o?.customer_name ?? r.order_id}
          {o?.kind === 'replacement' && (
            <span className="replBadge" title="Warranty / service replacement — not a sale">
              {replacementBadgeLabel(o)}
            </span>
          )}
          <span className={styles.stepBadge}>{r.step}/6</span>
        </div>
        <div className={styles.rowMeta}>
          {o?.order_ref ?? '—'} · {o?.city ?? ''} · {o?.country ?? ''}
        </div>
        {pickupSend && (
          <div
            className={`${styles.refundBadge} ${styles.pickupBadge}`}
            title={pickupBadgeTitle(pickupSend, r.step)}
          >
            {PICKUP_BADGE_LABEL}
          </div>
        )}
        {shippedMark && (
          <div
            className={`${styles.refundBadge} ${styles.refundBadgeSoft}`}
            title={shippedMarkTitle(shippedMark)}
          >
            {shippedMarkLabel(shippedMark)}
          </div>
        )}
        {refundFlag && (
          <div
            className={`${styles.refundBadge} ${refundFlag.level === 'order' ? '' : styles.refundBadgeSoft}`}
            title={refundFlagTitle(refundFlag)}
          >
            {refundFlagLabel(refundFlag)}
          </div>
        )}
        {pauseBadge ? (
          <div className={styles.pauseBadge}>{pauseBadge}</div>
        ) : (
          <div className={dueClass(r.due_date, fulfilled)}>
            {dueLabel(r.due_date, fulfilled)}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTabs}>
        {(['ready', 'pickup', 'shipped'] as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.sidebarTab} ${tab === t ? styles.activeTab : ''}`}
            onClick={() => setTab(t)}
          >
            {/* Label above count rather than beside it: three rails in a 300px
                rail leaves ~100px each, and "To be picked up 9" on one line
                either clips or forces the other two to. */}
            <span className={styles.sidebarTabLabel}>{TAB_LABEL[t]}</span>{' '}
            <span className={styles.sidebarTabCount}>{population[t].length}</span>
          </button>
        ))}
      </div>
      {population[tab].length > 0 && (
        <div className={styles.sidebarSearchWrap}>
          <span className={styles.sidebarSearchIcon} aria-hidden="true">⌕</span>
          <input
            className={styles.sidebarSearch}
            type="search"
            placeholder="Search a customer or order #…"
            aria-label={TAB_SEARCH_LABEL[tab]}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className={styles.sidebarSearchClear}
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >×</button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        // "No queued orders." told an operator nothing they could act on, and
        // an empty ready-queue is the one moment they have attention to spare.
        // Each state now says what is true and where the next row comes from.
        needle ? (
          // A search that finds nothing must not read as an empty queue — say
          // what was searched for, point at the other tab when the order is
          // sitting in it, and offer the way back to the whole list.
          <EmptyState
            title={`No ${TAB_NOUN[tab]} matches “${query.trim()}”`}
            body={
              elsewhere.length > 0
                ? elsewhereLine
                : 'Search runs over the customer name and the order ref.'
            }
            action={
              elsewhere.length > 0
                ? <Button small onClick={() => setTab(elsewhere[0])}>
                    Look in {TAB_LABEL[elsewhere[0]]}
                  </Button>
                  // Named for the outcome, not the mechanism — the ✕ in the
                  // box is already "Clear search", and two controls with one
                  // name is a coin toss for anyone driving this by keyboard.
                : <Button small onClick={() => setQuery('')}>Show all orders</Button>
            }
          />
        ) : tab === 'ready' ? (
          <EmptyState
            title="Nothing queued"
            body="Orders arrive here once they are confirmed in Sales."
            action={<Button small onClick={() => navigate('/order-review')}>Go to Sales</Button>}
          />
        ) : tab === 'pickup' ? (
          <EmptyState
            title="Nothing waiting on a carrier"
            body="An order moves here once its label is confirmed, it reaches the dock handoff, and the Goorooship email carrying it has gone out."
          />
        ) : (
          <EmptyState
            title="Nothing shipped yet"
            body="Orders move here as they leave the dock."
          />
        )
      ) : tab === 'ready' ? (
        matchedReady.map(renderRow)
      ) : tab === 'pickup' ? (
        matchedPickup.map(renderRow)
      ) : (
        shippedGroups.map(g => (
          <div key={g.key || 'undated'} className={styles.monthGroup}>
            {/* Sticky so the month you are scrolling through stays named — the
                tab is 100+ rows deep and the heading is the only landmark. */}
            <h3 className={styles.monthHeading}>
              {g.label}
              <span className={styles.monthCount}>{g.rows.length}</span>
            </h3>
            {g.rows.map(renderRow)}
          </div>
        ))
      )}
    </aside>
  );
}
