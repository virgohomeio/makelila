import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export function QueueHeader({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { order_ref: string; customer_name: string; city: string; region_state: string | null; country: 'US'|'CA' };
}) {
  const STEP_LABELS = ['', 'Assign', 'Test', 'Label', 'Dock', 'Email', 'Fulfilled'];
  return (
    <div className={styles.header}>
      <div className={styles.headerTitle}>
        {order.customer_name} — LILA Pro
      </div>
      <div className={styles.headerMeta}>
        {order.order_ref} · {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
        {row.due_date && <> · Due {new Date(row.due_date).toLocaleDateString()}</>}
      </div>
      <div className={styles.progressBar} aria-label={`Step ${row.step} of 6 — ${STEP_LABELS[row.step]}`}>
        {[1,2,3,4,5,6].map(s => (
          <div
            key={s}
            className={[
              styles.progressStep,
              s < row.step ? styles.done : '',
              s === row.step ? styles.current : '',
            ].filter(Boolean).join(' ')}
          />
        ))}
      </div>
    </div>
  );
}
