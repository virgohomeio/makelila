import type { Order } from '../../../lib/orders';

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
// from CRITERIA_COUNT so the copy cannot drift from the logic again.
//
// Pure — no JSX here, so the queue's "Blocked" saved view can ask the same
// question the detail pane answers without importing a component.

/** The number of criteria that gate Confirm. Single source for every count
 *  rendered anywhere in the module. */
export const CRITERIA_COUNT = 2;

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

export function canConfirm(order: Order): boolean {
  const r = evaluateReadiness(order);
  return r.contact && r.address;
}
