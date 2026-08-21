import styles from '../OrderReview.module.css';

/** DOM ids the blocker strip's "Fix in …" buttons scroll to. Declared here
 *  rather than inlined at both ends so the card and the link targeting it
 *  cannot drift apart. */
export const CUSTOMER_CARD_ID = 'order-review-customer-card';
export const ADDRESS_CARD_ID  = 'order-review-address-card';

/** Scroll a detail card into view and flash its border once. The blocker strip
 *  names a fault; this is what carries you to where the fault is fixed. */
export function revealCard(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Restart the animation even if the same card is targeted twice in a row —
  // removing the class alone doesn't retrigger it without a reflow.
  el.classList.remove(styles.cardFlash);
  void el.offsetWidth;
  el.classList.add(styles.cardFlash);
}
