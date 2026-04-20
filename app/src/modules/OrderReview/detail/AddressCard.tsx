import type { Order } from '../../../lib/orders';
import { setSalesConfirmedFit } from '../../../lib/orders';
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

function MissingField() {
  return <span className={styles.missing}>Missing — complete via QUO</span>;
}

export function AddressCard({ order }: { order: Order }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Shipping Address</div>
      <div className={styles.cardBody}>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Street</span>
          {order.address_line
            ? <span>{order.address_line}</span>
            : <MissingField />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>City</span>
          <span>{order.city}</span>
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Region</span>
          {order.region_state
            ? <span>{order.region_state}</span>
            : <MissingField />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Country</span>
          <span>{order.country}</span>
        </div>

        <div className={`${styles.verdict} ${VERDICT_CLASS[order.address_verdict]}`} style={{ marginTop: 12 }}>
          <strong>{order.address_verdict.toUpperCase()}</strong>
          <span>{VERDICT_LABEL[order.address_verdict]}</span>
        </div>

        {order.address_verdict !== 'house' && (
          <div className={styles.salesConfirmToggle}>
            <input
              type="checkbox"
              id={`sales-fit-${order.id}`}
              checked={order.sales_confirmed_fit}
              onChange={async e => {
                try { await setSalesConfirmedFit(order.id, e.target.checked); }
                catch (err) { alert((err as Error).message); }
              }}
            />
            <label htmlFor={`sales-fit-${order.id}`}>
              Sales confirmed fit with customer (required for {order.address_verdict} addresses)
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
