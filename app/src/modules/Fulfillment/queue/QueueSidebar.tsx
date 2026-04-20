import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

function dueClass(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return `${styles.rowDue} ${styles.done}`;
  if (!dueDate) return styles.rowDue;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `${styles.rowDue} ${styles.today}`;
  if (days === 0) return `${styles.rowDue} ${styles.today}`;
  if (days <= 2) return `${styles.rowDue} ${styles.soon}`;
  return `${styles.rowDue} ${styles.ok}`;
}

function dueLabel(dueDate: string | null, fulfilled: boolean): string {
  if (fulfilled) return '✓ Fulfilled';
  if (!dueDate) return '—';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate); due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
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
  orderLookup: Map<string, { order_ref: string; customer_name: string; city: string; country: 'US'|'CA' }>;
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
        const cls = [
          styles.queueRow,
          r.id === selectedId ? styles.selected : '',
          overdue ? styles.overdue : '',
          fulfilled ? styles.fulfilled : '',
          r.priority && !fulfilled ? styles.priority : '',
        ].filter(Boolean).join(' ');
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
            <div className={dueClass(r.due_date, fulfilled)}>
              {dueLabel(r.due_date, fulfilled)}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
