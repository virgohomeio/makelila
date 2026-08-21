import type { Order } from '../../../lib/orders';
import { CUSTOMER_CARD_ID, ADDRESS_CARD_ID, revealCard } from './anchors';
import styles from '../OrderReview.module.css';

// Per Pedrum (2026-06-05): drop the freight readiness check. With the
// $100 CAD shipping credit policy in place (#65), the freight estimate
// is no longer a gating concern at order-confirm time — operators
// still see it on the FreightCard for informational purposes, but a
// missing/high freight quote no longer blocks the confirm.
//
// The check was: freight 0 < freight_estimate ≤ freight_threshold_usd.
//
// There are TWO criteria, not three. The action bar claimed three for
// months after the freight check was dropped; the count is now derived
// from CRITERIA below so the copy cannot drift from the logic again.
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
  if (!streetOk) missing.push('street address');
  const reason1 = contact
    ? 'Email, phone and street address are all on file'
    : `No ${missing.join(', no ')} on file`;

  const addressOk = order.address_verdict === 'house' || order.sales_confirmed_fit;
  const reason2 = addressOk
    ? (order.address_verdict === 'house'
        ? 'Single-family house — standard delivery'
        : `${order.address_verdict} address — sales already confirmed fit`)
    : `${order.address_verdict} address — sales has not confirmed the unit fits`;

  return { contact, address: addressOk, reason1, reason2 };
}

/** The number of criteria that gate Confirm. Single source for every count
 *  rendered anywhere in the module. */
export const CRITERIA_COUNT = 2;

export function canConfirm(order: Order): boolean {
  const r = evaluateReadiness(order);
  return r.contact && r.address;
}

/** The blocker strip. Sits directly under the Confirm button it gates, so the
 *  fault and the button are never on separate screens, and puts the repair
 *  link on the same line as the fault it repairs. */
export function ReadinessChecklist({ order }: { order: Order }) {
  const r = evaluateReadiness(order);
  const met = [r.contact, r.address].filter(Boolean).length;
  const allOk = met === CRITERIA_COUNT;
  const outstanding = CRITERIA_COUNT - met;

  if (allOk) {
    return (
      <div className={`${styles.blockers} ${styles.blockersOk}`}>
        <div className={styles.blockHead}>
          <span className={styles.blockCount}>{met} of {CRITERIA_COUNT}</span>
          criteria met — ready to confirm
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.blockers} ${styles.blockersWarn}`}>
      <div className={styles.blockHead}>
        {outstanding} blocker{outstanding === 1 ? '' : 's'} before you can confirm
        <span className={styles.blockCount}>· {met} of {CRITERIA_COUNT} met</span>
      </div>
      <div className={styles.blockList}>
        <div className={styles.blockItem}>
          <span className={`${styles.blockMark} ${r.contact ? styles.blockMarkOk : styles.blockMarkNo}`}>
            {r.contact ? '✓' : '!'}
          </span>
          <span className={styles.blockWhat}>Contact info</span>
          <span className={styles.blockWhy}>{r.reason1}</span>
          {!r.contact && (
            <button
              type="button"
              className={styles.blockFix}
              onClick={() => revealCard(CUSTOMER_CARD_ID)}
            >Fix in Customer →</button>
          )}
        </div>
        <div className={styles.blockItem}>
          <span className={`${styles.blockMark} ${r.address ? styles.blockMarkOk : styles.blockMarkNo}`}>
            {r.address ? '✓' : '!'}
          </span>
          <span className={styles.blockWhat}>Address fit</span>
          <span className={styles.blockWhy}>{r.reason2}</span>
          {!r.address && (
            <button
              type="button"
              className={styles.blockFix}
              onClick={() => revealCard(ADDRESS_CARD_ID)}
            >Fix in Address →</button>
          )}
        </div>
      </div>
    </div>
  );
}
