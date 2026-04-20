import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function evaluateReadiness(order: Order): {
  contact: boolean;
  address: boolean;
  freight: boolean;
  reason1: string;
  reason2: string;
  reason3: string;
} {
  const emailOk = !!order.customer_email;
  const phoneOk = !!order.customer_phone;
  const streetOk = !!order.address_line;
  const contact = emailOk && phoneOk && streetOk;
  const missing: string[] = [];
  if (!emailOk) missing.push('email');
  if (!phoneOk) missing.push('phone');
  if (!streetOk) missing.push('street');
  const reason1 = contact
    ? 'Complete (email, phone, address)'
    : `Missing ${missing.join(', ')} — complete via QUO`;

  const addressOk = order.address_verdict === 'house' || order.sales_confirmed_fit;
  const reason2 = addressOk
    ? (order.address_verdict === 'house'
        ? 'House address'
        : `${order.address_verdict} address — sales confirmed fit`)
    : `${order.address_verdict} address — sales must confirm fit with customer`;

  const freightValue = Number(order.freight_estimate_usd) || 0;
  const threshold = Number(order.freight_threshold_usd) || 200;
  const freightOk = freightValue > 0 && freightValue <= threshold;
  const reason3 = freightValue <= 0
    ? 'Freight not synced — get quote from Freightcom'
    : freightValue > threshold
      ? `Freight $${freightValue.toFixed(2)} exceeds $${threshold.toFixed(2)} threshold`
      : `Freight $${freightValue.toFixed(2)} within $${threshold.toFixed(2)} threshold`;

  return { contact, address: addressOk, freight: freightOk, reason1, reason2, reason3 };
}

export function canConfirm(order: Order): boolean {
  const r = evaluateReadiness(order);
  return r.contact && r.address && r.freight;
}

export function ReadinessChecklist({ order }: { order: Order }) {
  const r = evaluateReadiness(order);
  const allOk = r.contact && r.address && r.freight;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead} style={{ color: allOk ? 'var(--color-success)' : 'var(--color-warning)' }}>
        Ready to confirm? — {[r.contact, r.address, r.freight].filter(Boolean).length} of 3 met
      </div>
      <div className={styles.cardBody}>
        <div className={styles.readinessRow}>
          <span className={r.contact ? styles.readinessOk : styles.readinessFail}>
            {r.contact ? '✓' : '✗'}
          </span>
          <span><strong>Contact info:</strong> {r.reason1}</span>
        </div>
        <div className={styles.readinessRow}>
          <span className={r.address ? styles.readinessOk : styles.readinessFail}>
            {r.address ? '✓' : '✗'}
          </span>
          <span><strong>Address fit:</strong> {r.reason2}</span>
        </div>
        <div className={styles.readinessRow}>
          <span className={r.freight ? styles.readinessOk : styles.readinessFail}>
            {r.freight ? '✓' : '✗'}
          </span>
          <span><strong>Freight:</strong> {r.reason3}</span>
        </div>
      </div>
    </div>
  );
}
