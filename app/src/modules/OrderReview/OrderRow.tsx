import type { Order } from '../../lib/orders';
import { orderUrgency } from '../../lib/orders';
import styles from './OrderReview.module.css';

export function OrderRow({
  order,
  isSelected,
  onClick,
}: {
  order: Order;
  isSelected: boolean;
  onClick: () => void;
}) {
  const cls = [
    styles.row,
    isSelected ? styles.selected : '',
    order.status === 'flagged' ? styles.flaggedRow : '',
  ].filter(Boolean).join(' ');

  const countryTag = order.country === 'CA' ? styles.tagCa : styles.tagUs;
  const isRiskAddress = order.address_verdict === 'apt' || order.address_verdict === 'condo' || order.address_verdict === 'remote';

  return (
    <div className={cls} onClick={onClick} role="button" tabIndex={0}>
      <div className={styles.rowName}>{order.customer_name}</div>
      <div className={styles.rowMeta}>
        <span className={`${styles.tag} ${countryTag}`}>{order.country}</span>
        {isRiskAddress && (
          <span className={`${styles.tag} ${styles.tagWarn}`}>{order.address_verdict}</span>
        )}
        {order.order_ref} · {order.city}
        {(() => {
          const u = orderUrgency(order.placed_at);
          if (!u.label) return null;
          return <span className={`${styles.urgencyChip} ${styles[u.severity]}`}>{u.label}</span>;
        })()}
      </div>
    </div>
  );
}
