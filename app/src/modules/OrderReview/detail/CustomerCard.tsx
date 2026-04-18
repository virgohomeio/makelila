import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

function MissingField() {
  return <span className={styles.missing}>Missing — complete via QUO</span>;
}

export function CustomerCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Customer</div>
      <div className={styles.cardBody}>
        <div style={{ fontWeight: 700 }}>{order.customer_name}</div>

        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Email</span>
          {order.customer_email
            ? <span>{order.customer_email}</span>
            : <MissingField />}
        </div>

        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Phone</span>
          {order.customer_phone
            ? <span>{order.customer_phone}</span>
            : <MissingField />}
        </div>

        {order.quo_thread_url && (
          <a
            className={styles.quoLink}
            href={order.quo_thread_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ marginTop: 10 }}
          >
            Open QUO ↗
          </a>
        )}
      </div>
    </div>
  );
}
