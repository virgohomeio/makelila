import type { Order } from '../../../lib/orders';
import { evaluateReadiness, CRITERIA_COUNT } from './readiness';
import { CUSTOMER_CARD_ID, ADDRESS_CARD_ID, revealCard } from './anchors';
import styles from '../OrderReview.module.css';

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
