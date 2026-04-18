import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function CustomerCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Customer</div>
      <div className={styles.cardBody}>
        <div style={{ fontWeight: 700 }}>{order.customer_name}</div>
        {order.customer_email && <div className={styles.muted}>{order.customer_email}</div>}
        {order.customer_phone && <div className={styles.muted}>{order.customer_phone}</div>}
        {order.quo_thread_url && (
          <a
            className={styles.quoLink}
            href={order.quo_thread_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open QUO ↗
          </a>
        )}
      </div>
    </div>
  );
}
