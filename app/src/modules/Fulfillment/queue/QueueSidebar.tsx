import { useState } from 'react';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { Order, OrderStatus } from '../../../lib/orders';
import { replacementItemTags } from '../../../lib/replacementTags';
import { refundFlagLabel, refundFlagTitle, type RefundFlag } from '../../../lib/refundedOrders';
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

export function QueueSidebar({
  readyRows,
  shippedRows,
  orderLookup,
  selectedId,
  onSelect,
  refundFlags,
}: {
  readyRows: FulfillmentQueueRow[];
  shippedRows: FulfillmentQueueRow[];
  orderLookup: Map<string, QueueOrderSummary>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Orders with a refund against them, by order id. A queued order whose money
   *  has gone back must not be picked, and the picker works from this rail. */
  refundFlags?: Map<string, RefundFlag>;
}) {
  const [tab, setTab] = useState<'ready' | 'shipped'>('ready');
  const navigate = useNavigate();
  const rows = tab === 'ready' ? readyRows : shippedRows;

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTabs}>
        <button
          className={`${styles.sidebarTab} ${tab === 'ready' ? styles.activeTab : ''}`}
          onClick={() => setTab('ready')}
        >
          Ready to ship <span className={styles.sidebarTabCount}>{readyRows.length}</span>
        </button>
        <button
          className={`${styles.sidebarTab} ${tab === 'shipped' ? styles.activeTab : ''}`}
          onClick={() => setTab('shipped')}
        >
          Shipped <span className={styles.sidebarTabCount}>{shippedRows.length}</span>
        </button>
      </div>
      {rows.length === 0 ? (
        // "No queued orders." told an operator nothing they could act on, and
        // an empty ready-queue is the one moment they have attention to spare.
        // Each state now says what is true and where the next row comes from.
        tab === 'ready' ? (
          <EmptyState
            title="Nothing queued"
            body="Orders arrive here once they are confirmed in Sales."
            action={<Button small onClick={() => navigate('/order-review')}>Go to Sales</Button>}
          />
        ) : (
          <EmptyState
            title="Nothing shipped yet"
            body="Orders move here as they leave the dock."
          />
        )
      ) : rows.map(r => {
        const o = orderLookup.get(r.order_id);
        const fulfilled = r.step === 6;
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
      })}
    </aside>
  );
}
