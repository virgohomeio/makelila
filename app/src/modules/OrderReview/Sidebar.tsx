import type { Order } from '../../lib/orders';
import { SLA_TICKS } from './sla';
import { OrderRow } from './OrderRow';
import styles from './OrderReview.module.css';

/** The shared SLA axis, drawn once at the top of the list. Every rail below it
 *  is plotted against these ticks — that is what turns a column of unrelated
 *  ages into a readable shape. Mirrors DwellAxis on Support Tickets. */
function SlaAxis() {
  return (
    <span className={styles.slaHead}>
      <span className={styles.slaAxis} aria-hidden="true">
        {SLA_TICKS.map(t => (
          <span key={t.label} className={styles.slaTick} style={{ left: `${t.pct}%` }}>
            {t.label}
          </span>
        ))}
      </span>
      Since placed
    </span>
  );
}

/**
 * The order list.
 *
 * Purely presentational — status, saved views, search and the field filters
 * all live in the page above (see index.tsx), the same way SupportTab owns its
 * filtering. Everything this renders comes from `orders`, already filtered and
 * sorted by filters.ts.
 */
export function Sidebar({
  orders,
  now,
  selectedId,
  onSelect,
  emptyHint,
}: {
  orders: Order[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** What to say when nothing matches — the page knows whether that is an
   *  empty queue or an over-narrow filter, and this does not. */
  emptyHint: string;
}) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.listHead}>
        <span className={styles.listCount}>
          {orders.length} order{orders.length === 1 ? '' : 's'}
        </span>
        <SlaAxis />
      </div>

      <div className={styles.list}>
        {orders.length === 0 ? (
          <div className={styles.emptyList}>{emptyHint}</div>
        ) : orders.map(o => (
          <OrderRow
            key={o.id}
            order={o}
            now={now}
            isSelected={o.id === selectedId}
            onClick={() => onSelect(o.id)}
          />
        ))}
      </div>
    </aside>
  );
}
