import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

// Per Pedrum (2026-06-05): drop the freight readiness check. With the
// $100 CAD shipping credit policy in place (#65), the freight estimate
// is no longer a gating concern at order-confirm time — operators
// still see it on the FreightCard for informational purposes, but a
// missing/high freight quote no longer blocks the confirm.
//
// The check was: freight 0 < freight_estimate ≤ freight_threshold_usd.
export function evaluateReadiness(order: Order): {
  contact: boolean;
  address: boolean;
  reason1: string;
  reason2: string;
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

  return { contact, address: addressOk, reason1, reason2 };
}

export function canConfirm(order: Order): boolean {
  const r = evaluateReadiness(order);
  return r.contact && r.address;
}

export function ReadinessChecklist({ order }: { order: Order }) {
  const r = evaluateReadiness(order);
  const allOk = r.contact && r.address;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead} style={{ color: allOk ? 'var(--color-success)' : 'var(--color-warning)' }}>
        Ready to confirm? — {[r.contact, r.address].filter(Boolean).length} of 2 met
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
      </div>
    </div>
  );
}
