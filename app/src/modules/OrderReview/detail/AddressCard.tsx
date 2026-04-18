import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

const VERDICT_CLASS: Record<Order['address_verdict'], string> = {
  house:  styles.verdictHouse,
  apt:    styles.verdictApt,
  condo:  styles.verdictCondo,
  remote: styles.verdictRemote,
};

const VERDICT_LABEL: Record<Order['address_verdict'], string> = {
  house:  'Single-family · standard delivery',
  apt:    'Apartment · delivery may need coordination',
  condo:  'Condo · concierge / dock concerns',
  remote: 'Remote area · freight surcharge likely',
};

export function AddressCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Shipping Address</div>
      <div className={styles.cardBody}>
        <div>{order.address_line}</div>
        <div className={styles.muted}>
          {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
        </div>
        <div className={`${styles.verdict} ${VERDICT_CLASS[order.address_verdict]}`}>
          <strong>{order.address_verdict.toUpperCase()}</strong>
          <span>{VERDICT_LABEL[order.address_verdict]}</span>
        </div>
      </div>
    </div>
  );
}
