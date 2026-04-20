import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { OrderStatus } from '../../../lib/orders';
import styles from '../Fulfillment.module.css';

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
  rows,
  orderLookup,
  selectedId,
  onSelect,
}: {
  rows: FulfillmentQueueRow[];
  orderLookup: Map<string, { order_ref: string; customer_name: string; city: string; country: 'US'|'CA'; status?: OrderStatus }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>READY TO SHIP ({rows.length})</div>
      {rows.length === 0 ? (
        <div className={styles.emptyList}>No queued orders.</div>
      ) : rows.map(r => {
        const o = orderLookup.get(r.order_id);
        const fulfilled = r.step === 6;
        const overdue = !fulfilled && r.due_date && new Date(r.due_date) < new Date(new Date().setHours(0,0,0,0));
        const paused = !fulfilled && o?.status && o.status !== 'approved';
        const cls = [
          styles.queueRow,
          r.id === selectedId ? styles.selected : '',
          overdue ? styles.overdue : '',
          fulfilled ? styles.fulfilled : '',
          r.priority && !fulfilled ? styles.priority : '',
          paused ? styles.paused : '',
        ].filter(Boolean).join(' ');
        const pauseBadge = paused
          ? (o?.status === 'flagged' ? '⚑ FLAGGED' : o?.status === 'held' ? '⏸ HELD' : '• PAUSED')
          : null;
        return (
          <div key={r.id} className={cls} onClick={() => onSelect(r.id)} role="button" tabIndex={0}>
            <div className={styles.rowName}>
              {r.priority && !fulfilled && <span className={styles.priorityBadge} title="Priority — expedite">⭐</span>}
              {o?.customer_name ?? r.order_id}
              <span className={styles.stepBadge}>{r.step}/6</span>
            </div>
            <div className={styles.rowMeta}>
              {o?.order_ref ?? '—'} · {o?.city ?? ''} · {o?.country ?? ''}
            </div>
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
