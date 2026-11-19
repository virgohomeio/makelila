// "Which inbox does this order's mail go to?"
//
// One definition, shared by the Fulfillment queue's Step 5 and the
// send-fulfillment-email edge function that actually posts it to Resend.
//
// The two copies, and why they drifted
// ------------------------------------
// `orders.customer_email` is a SNAPSHOT taken when the row was created. For a
// sale that snapshot comes from Shopify and is always there. For a REPLACEMENT
// it is copied off the service ticket — and a ticket raised by hand from a
// phone call (`source: 'ops_manual'`) has no email on it, so the order is born
// with a null column while the customer record holds the address all along.
//
// That is R-0023: Candace Chan reached Step 5 with
// `orders.customer_email = null` and `garycandacechan@gmail.com` on her
// customer row, and both gates — the Step-5 button and the edge function —
// read only the order column. The operator was told to "go add an email in
// Customers" for an address makeLILA already had, and the shipment
// confirmation could not be sent at all.
//
// Nine of the eleven orders with no `customer_email` are that exact shape: a
// null column beside a linked customer row that has the address. So the
// recipient is now DERIVED — the order's own column first, the linked
// directory row second — the same move lib/customerAddress.ts makes for the
// shipping address and lib/heldUnits.ts for held serials. The snapshot still
// wins when it is populated: it is what the customer typed at checkout for
// that order.
//
// The name guard
// --------------
// `orders.customer_id` is set by a database trigger
// (`orders_set_customer_id_from_email_or_name`) that matches on email OR NAME,
// and a name match can land on the wrong person — the June backfill mis-linked
// nine unit FKs exactly that way. Emailing one customer's shipment
// confirmation to another is worse than asking the operator to type an
// address, so the directory fallback is taken ONLY when the order and the
// directory row name the same person. A mismatch falls through to the Step-5
// blocker, which is the behaviour that was there before.
//
// Keep in sync with resolveRecipient() in
// supabase/functions/send-fulfillment-email/index.ts — the edge function runs
// in Deno and cannot import this file, and it is the authoritative gate.

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

const trimmed = (v: string | null | undefined): string | null => (v ?? '').trim() || null;

/** Where the address came from. 'order' is the snapshot on the order row,
 *  'directory' the linked customer record. Shown to the operator, because an
 *  address they never typed on this order deserves saying so. */
export type RecipientSource = 'order' | 'directory';

/** The order columns this module reads — every one of them also a field of
 *  `Order`, so an `Order` is accepted wherever this is. */
export interface RecipientOrder {
  customer_name: string;
  customer_email: string | null;
  customer_id?: string | null;
}

/** The customer columns this module reads. `primary_user_email` is here
 *  because outbound mail addresses the person running the machine, not
 *  necessarily the person who paid — see resolveCustomerParties in
 *  lib/customers.ts, whose precedence this follows. */
export interface RecipientCustomer {
  id: string;
  full_name: string | null;
  email: string | null;
  primary_user_email: string | null;
}

/** Select list for `RecipientCustomer`, kept next to the type so a column
 *  added to one is added to the other. */
export const RECIPIENT_CUSTOMER_COLUMNS = 'id, full_name, email, primary_user_email';

export interface ResolvedRecipient {
  email: string | null;
  source: RecipientSource | null;
  /** True when a directory row WAS linked and carried an address, but named
   *  someone else — so the operator is told the link is suspect rather than
   *  just "no email on file". */
  nameMismatch: boolean;
}

/** Two spellings of the same person. Internal whitespace is collapsed as well
 *  as trimmed: `customers.full_name` is generated from first_name + last_name,
 *  so a blank component leaves a double space where the order has one. A blank
 *  on either side is never a match — it would make every unnamed row "the
 *  same person". */
export function sameParty(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  return na !== '' && na === nb;
}

/** Resolve the one address this order's mail should go to. Pure — the caller
 *  supplies the linked customer row (or null when there is none). */
export function resolveOrderRecipient(
  order: RecipientOrder,
  customer: RecipientCustomer | null | undefined,
): ResolvedRecipient {
  const onOrder = trimmed(order.customer_email);
  if (onOrder) return { email: onOrder, source: 'order', nameMismatch: false };

  // Precedence mirrors resolveCustomerParties: the primary user's own address
  // when recorded, else the record's. Two rules for "where does mail go" would
  // let one household be reachable in Service and unreachable in Fulfillment.
  const fromDirectory = customer
    ? trimmed(customer.primary_user_email) ?? trimmed(customer.email)
    : null;
  if (!fromDirectory) return { email: null, source: null, nameMismatch: false };

  if (!sameParty(order.customer_name, customer?.full_name)) {
    return { email: null, source: null, nameMismatch: true };
  }
  return { email: fromDirectory, source: 'directory', nameMismatch: false };
}

/** `resolveOrderRecipient` plus the read of the linked customer row.
 *
 *  Nothing is fetched when the order carries its own address, which is every
 *  sale — the query runs only for the handful of rows that need the fallback. */
export function useOrderRecipient(order: RecipientOrder): ResolvedRecipient & { loading: boolean } {
  const onOrder = trimmed(order.customer_email);
  const customerId = order.customer_id ?? null;
  const needsLookup = !onOrder && !!customerId;

  const [customer, setCustomer] = useState<RecipientCustomer | null>(null);
  const [loading, setLoading] = useState(needsLookup);

  useEffect(() => {
    if (!needsLookup || !customerId) { setCustomer(null); setLoading(false); return; }
    let live = true;
    setLoading(true);
    void supabase
      .from('customers')
      .select(RECIPIENT_CUSTOMER_COLUMNS)
      .eq('id', customerId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!live) return;
        // A failed lookup leaves the step blocked rather than silently
        // addressing the mail somewhere else.
        if (error) console.error('Recipient lookup failed:', error.message);
        setCustomer((data as RecipientCustomer | null) ?? null);
        setLoading(false);
      });
    return () => { live = false; };
  }, [needsLookup, customerId]);

  return { ...resolveOrderRecipient(order, customer), loading };
}
