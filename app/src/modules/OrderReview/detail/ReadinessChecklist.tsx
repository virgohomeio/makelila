import type { Order } from '../../../lib/orders';
import { needsRuralManualCheck, ruralCheckAvailable } from '../../../lib/orders';
import { DWELLING_LABEL, needsFitConfirmation } from '../../../lib/addressClassify';
import { CUSTOMER_CARD_ID, ADDRESS_CARD_ID, PRECHECK_ID, revealCard } from './anchors';
import styles from '../OrderReview.module.css';

// Per Pedrum (2026-06-05): drop the freight readiness check. With the
// $100 CAD shipping credit policy in place (#65), the freight estimate
// is no longer a gating concern at order-confirm time — operators
// still see it on the FreightCard for informational purposes, but a
// missing/high freight quote no longer blocks the confirm.
//
// The check was: freight 0 < freight_estimate ≤ freight_threshold_usd.
// It has NOT come back: the third criterion below asks whether anybody RAN the
// two pre-ship checks, and does not care what the freight number is. A $400
// quote to Whitehorse still confirms; confirming with nobody having checked the
// postal code no longer does.
//
// Every count rendered anywhere in the module derives from criteriaCount(), so
// the copy cannot drift from the logic — it claimed three criteria for months
// after the freight check was dropped.
/** Has a carrier rate actually been pulled for this order?
 *
 *  `freight_estimate_usd > 0` alone is not the question. Shopify seeds that
 *  column with what the CUSTOMER paid for shipping, which is a price we set in
 *  a storefront, not a quote from a carrier — reading it as "freight is known"
 *  is how an order reaches the dock costed against a number nobody looked up.
 *  Only a live carrier quote, or an operator pasting a portal one, counts. */
export function freightQuoted(order: Order): boolean {
  if (order.freight_estimate_source === 'freightcom') return true;
  if (order.freight_estimate_source === 'clickship') return true;
  return order.freight_estimate_source === 'manual' && order.freight_estimate_usd > 0;
}

export function evaluateReadiness(order: Order): {
  contact: boolean;
  address: boolean;
  preship: boolean;
  /** The rural/remote manual check. True when it is met OR not asked for, so
   *  the three older criteria keep counting the way they always did on the
   *  orders that don't go anywhere rural. */
  rural: boolean;
  /** Whether the fourth criterion applies to this order at all — the strip
   *  renders a row only when it does. */
  ruralRequired: boolean;
  reason1: string;
  reason2: string;
  reason3: string;
  reason4: string;
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

  // The dwelling gate. An UNCONFIRMED verdict still passes: it is the default
  // state of every order that nobody has verified yet, and blocking on it would
  // strand the whole pending queue behind a button click. The checklist says so
  // out loud instead, so "this one is fine" reads differently from "nobody has
  // looked at this one".
  //
  // A missing unit number does NOT pass, whatever the dwelling type says. The
  // street is confirmed, the building has units, and no unit is on the order —
  // a freight driver has nowhere to leave a pallet. Sales confirming fit does
  // not conjure a unit number, so this one can only be cleared by getting the
  // number from the customer.
  const unitMissing = order.address_unit_status === 'missing';
  const dwellingOk = !needsFitConfirmation(order.address_verdict) || order.sales_confirmed_fit;
  const addressOk = dwellingOk && !unitMissing;
  const unverified = order.address_verdict_source === 'sync-guess';
  const dwellingLabel = DWELLING_LABEL[order.address_verdict].toLowerCase();
  const reason2 =
    unitMissing
      ? 'Multi-unit building with no unit number on the order — freight cannot be delivered'
    : !dwellingOk
      ? `${dwellingLabel} address — sales has not confirmed the unit fits`
    : needsFitConfirmation(order.address_verdict)
      ? `${dwellingLabel} address — sales already confirmed fit`
    : unverified
      ? 'Looks like a house, but the address has not been verified yet'
      : 'Single-family house, confirmed — standard delivery';

  // The third gate, added with the pre-confirm panel above it: the two checks
  // that decide whether this order can ship have to have been run, in order —
  // an address a postal authority has confirmed, and a carrier rate pulled
  // against it.
  //
  // Replacements never reach Order Review (they are born approved and live in
  // Fulfillment), but canConfirm is called from the rail for every row, so the
  // criterion answers honestly for one rather than blocking it.
  const verifiedOk = !!order.address_verified_at;
  const quoteOk = freightQuoted(order);
  const preship = order.kind !== 'sale' ? true : (verifiedOk && quoteOk);
  const reason3 =
    order.kind !== 'sale'
      ? 'Not required for a replacement'
    : verifiedOk && quoteOk
      ? 'Address verified, and freight quoted against it'
    : !verifiedOk && !quoteOk
      ? 'Neither check has been run — verify the address, then quote freight'
    : !verifiedOk
      ? 'Freight was quoted, but the address it was quoted against has not been verified'
      : 'Address verified — no carrier rate has been pulled for it yet';

  // The fourth gate, and the only conditional one: an order going somewhere
  // rural or remote does not confirm until a person says they looked at it.
  //
  // Everything needed to know this was already on screen — a grey "Rural" tag
  // on the rail row, an amber Area line in the summary above — and nothing
  // asked anybody for anything, so a rural delivery confirmed exactly like a
  // downtown house. What the operator is signing off is the three things the
  // classifier cannot: that the carrier serves the address, that the
  // extended-area surcharge is accepted, and that any arrangement the
  // customer needs (terminal pickup, an appointment, a tail-lift) is agreed.
  //
  // An unapplied migration must not be able to strand an order: the columns
  // ship behind the gated workflow, and until it runs the criterion says so
  // and passes.
  const ruralRequired = needsRuralManualCheck(order);
  const ruralColumns = ruralCheckAvailable(order);
  const ruralSignedAt = order.rural_check_confirmed_at ?? null;
  const rural = !ruralRequired || !ruralColumns || !!ruralSignedAt;
  const ruralWhat = order.area_type === 'rural' ? 'Rural or remote area' : 'Rural-route address';
  const reason4 =
    !ruralRequired
      ? 'Not a rural or remote delivery'
    : !ruralColumns
      ? `${ruralWhat} — check the carrier serves it before you confirm. (Sign-off is not recorded yet: the migration adding it has not been applied.)`
    : ruralSignedAt
      ? `${ruralWhat} — checked ${new Date(ruralSignedAt).toLocaleDateString('en-US')}`
      : `${ruralWhat} — nobody has checked that the carrier serves it and the surcharge is accepted`;

  return {
    contact, address: addressOk, preship, rural, ruralRequired,
    reason1, reason2, reason3, reason4,
  };
}

/** The number of criteria that gate Confirm for THIS order — three, plus the
 *  rural check when the address is one. Single source for every count rendered
 *  anywhere in the module, which is why it is a function now: a fixed 4 would
 *  tell every urban order it had a criterion it does not have. */
export function criteriaCount(order: Order): number {
  return needsRuralManualCheck(order) ? 4 : 3;
}

export function canConfirm(order: Order): boolean {
  const r = evaluateReadiness(order);
  return r.contact && r.address && r.preship && r.rural;
}

/** The blocker strip. Sits directly under the Confirm button it gates, so the
 *  fault and the button are never on separate screens, and puts the repair
 *  link on the same line as the fault it repairs. */
export function ReadinessChecklist({ order }: { order: Order }) {
  const r = evaluateReadiness(order);
  const total = criteriaCount(order);
  const met = [r.contact, r.address, r.preship, ...(r.ruralRequired ? [r.rural] : [])]
    .filter(Boolean).length;
  const allOk = met === total;
  const outstanding = total - met;

  if (allOk) {
    return (
      <div className={`${styles.blockers} ${styles.blockersOk}`}>
        <div className={styles.blockHead}>
          <span className={styles.blockCount}>{met} of {total}</span>
          criteria met — ready to confirm
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.blockers} ${styles.blockersWarn}`}>
      <div className={styles.blockHead}>
        {outstanding} blocker{outstanding === 1 ? '' : 's'} before you can confirm
        <span className={styles.blockCount}>· {met} of {total} met</span>
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
        <div className={styles.blockItem}>
          <span className={`${styles.blockMark} ${r.preship ? styles.blockMarkOk : styles.blockMarkNo}`}>
            {r.preship ? '✓' : '!'}
          </span>
          <span className={styles.blockWhat}>Pre-ship checks</span>
          <span className={styles.blockWhy}>{r.reason3}</span>
          {!r.preship && (
            <button
              type="button"
              className={styles.blockFix}
              onClick={() => revealCard(PRECHECK_ID)}
            >Run above →</button>
          )}
        </div>
        {/* Only on the orders it applies to. A permanent "not a rural
            delivery ✓" row on every order is a line of green nobody reads,
            and the whole point of this criterion is to be noticed on the few
            orders that have it. */}
        {r.ruralRequired && (
          <div className={styles.blockItem}>
            <span className={`${styles.blockMark} ${r.rural ? styles.blockMarkOk : styles.blockMarkNo}`}>
              {r.rural ? '✓' : '!'}
            </span>
            <span className={styles.blockWhat}>Rural delivery</span>
            <span className={styles.blockWhy}>{r.reason4}</span>
            {!r.rural && (
              <button
                type="button"
                className={styles.blockFix}
                onClick={() => revealCard(ADDRESS_CARD_ID)}
              >Fix in Address →</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
