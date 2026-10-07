// The compost starter — the fourth thing step 3 of the queue is waiting for.
//
// Every LILA machine ships with a bag of starter soil, and the soil does not
// come out of our warehouse: it is ordered off Amazon and goes to the customer
// direct. Nothing in the app asked for it. The tracking number had a field, but
// only on US orders and only as an optional extra under a Freightcom card that
// already looked finished — three of 63 US queue rows had one filled in on
// 2026-10-07. So the order got placed when somebody remembered to place it, and
// the customer who did not get soil found out before we did.
//
// It belongs at step 3 because step 3 is where the pickup is scheduled. Once
// the Goorooship email goes out the 3PL has the carton, and once "Pickup
// scheduled" is clicked the row leaves the packer's rail for "To be picked up"
// — at both of those moments the chance to notice a missing bag of soil has
// passed, and the only remaining fix is an apology. So the number gates both.
//
// The hard part is the orders that ship no soil. Demanding a number from all of
// them is how this failed the first time round: the US-only gate keyed on
// country alone, an order with no starter kit had no number to paste, and the
// row could not leave step 3 at all (5a01566, 2026-09-22). Two answers, not
// one:
//
//   a replacement   is exempt in code. A box with a lid in it is not a machine
//                   sale and the customer already has their soil.
//   anything else   can be let through, but only by an operator saying in words
//                   why there is no soil on this one. That is a row on the
//                   queue (starter_skipped_at/_by/_reason, 20261007120000) and a
//                   line in the activity log — so "skipped" and "forgotten"
//                   stay different things six months later.

import { supabase } from './supabase';
import { logAction } from './activityLog';

/** The activity_log type written when an order is let through without soil. */
export const STARTER_SKIP_ACTION = 'fq_starter_skipped';

/** What deciding this needs off a queue row. Structural rather than the whole
 *  FulfillmentQueueRow so a test can state one in three lines. */
export type StarterKitRow = {
  starter_tracking_num: string | null;
  /** Added by 20261007120000; undefined on a database that has not run it. */
  starter_skipped_at?: string | null;
  starter_skip_reason?: string | null;
};

/** What deciding this needs off the order. */
export type StarterKitOrder = {
  kind: 'sale' | 'replacement';
  country?: 'US' | 'CA' | string | null;
};

/** Where the operator goes to place the order. Amazon's storefronts are
 *  separate businesses with separate carts — a Canadian shipment booked on
 *  amazon.com arrives with a customs charge on a $30 bag of soil, when it
 *  arrives at all — so the destination picks the storefront. */
export function amazonOrdersUrl(country?: string | null): string {
  const host = country === 'CA' ? 'amazon.ca' : 'amazon.com';
  return `https://www.${host}/gp/your-account/order-history`;
}

/** Does this order owe the customer a bag of starter soil at all?
 *
 *  False for a replacement, whatever is in the box. A replacement goes to
 *  somebody who already bought a machine and already got the soil that came
 *  with it; sending another bag with a $24 lid is not the workflow. Every sale
 *  is in scope — US and CA alike. Starter soil has never been a US-only
 *  product, it was a US-only *field*, which is a different thing and the reason
 *  CA customers were the ones quietly going without. */
export function starterRequired(order: StarterKitOrder): boolean {
  return order.kind !== 'replacement';
}

/** Has the starter question been answered on this row — either a number is on
 *  it, or somebody has said why there is none? */
export function starterSettled(row: StarterKitRow): boolean {
  if (row.starter_tracking_num && row.starter_tracking_num.trim()) return true;
  return !!row.starter_skipped_at;
}

/** The blocker phrase for StepBlockers, or null when nothing is outstanding.
 *
 *  Phrased as the thing that is missing rather than as the field that is empty:
 *  the operator's job here is to go and buy a bag of soil, and "the Amazon
 *  starter-kit tracking number" is what they will have afterwards. */
export const STARTER_BLOCKER = 'the compost starter ordered, with its Amazon tracking number';

export function starterBlocker(order: StarterKitOrder, row: StarterKitRow): string | null {
  if (!starterRequired(order)) return null;
  if (starterSettled(row)) return null;
  return STARTER_BLOCKER;
}

/** Save the Amazon tracking number against the row as soon as it is typed.
 *
 *  Separate from confirmLabel, which is the end of step 3. The number has to be
 *  on the row before that, because the Goorooship email is gated on it too and
 *  that send happens first — an operator who typed the number, mailed the 3PL
 *  and then reloaded would otherwise come back to an empty field and a step
 *  that would not let them past. */
export async function saveStarterTracking(queueId: string, tracking: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ starter_tracking_num: tracking.trim() || null })
    .eq('id', queueId);
  if (error) throw error;
}

/** Declare that this order ships no starter soil, and why.
 *
 *  The reason is required here and by a CHECK on the table: a skip with no
 *  reason on it is indistinguishable from a starter nobody got round to
 *  ordering, which is the failure this whole gate exists to make visible.
 *
 *  Clears any tracking number as it goes. The two answers are exclusive, and a
 *  row carrying both would put a starter-kit section in the customer's shipment
 *  email for a bag that was never bought. */
export async function skipStarterKit(
  queueId: string,
  reason: string,
  refs?: { orderRef?: string; orderId?: string },
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('Say why this order ships no starter soil.');
  const { data } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      starter_skipped_at: new Date().toISOString(),
      starter_skipped_by: data.user?.id ?? null,
      starter_skip_reason: trimmed,
      starter_tracking_num: null,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction(
    STARTER_SKIP_ACTION,
    refs?.orderRef ?? queueId,
    `No compost starter ships with this order — ${trimmed}`,
    refs?.orderId ? { entityType: 'order', entityId: refs.orderId } : undefined,
  );
}

/** Undo the declaration: the order does ship soil after all, and the number is
 *  required again. Logged like the skip was — an exception that comes and goes
 *  with no trace is worse than one that was never claimed. */
export async function unskipStarterKit(
  queueId: string,
  refs?: { orderRef?: string; orderId?: string },
): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ starter_skipped_at: null, starter_skipped_by: null, starter_skip_reason: null })
    .eq('id', queueId);
  if (error) throw error;
  await logAction(
    STARTER_SKIP_ACTION,
    refs?.orderRef ?? queueId,
    'Starter-soil exemption withdrawn — this order ships a compost starter after all.',
    refs?.orderId ? { entityType: 'order', entityId: refs.orderId } : undefined,
  );
}

/** True when the error is "that column isn't there" rather than a real failure.
 *
 *  Migrations here are applied by hand, so a frontend deploy can land before
 *  the DDL does. 42703 is Postgres' undefined_column; PGRST204 is PostgREST
 *  failing to find the column in its schema cache. An operator on a database
 *  without the migration gets told that, rather than a bare SQL error with the
 *  gate still shut. */
export function isMissingStarterSkipColumn(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === '42703' || code === 'PGRST204') return true;
  return /starter_skip/.test((e as Error | null)?.message ?? '');
}

/** What to put in front of the operator when a skip will not save.
 *
 *  The one failure worth translating is a database that has not run
 *  20261007120000 — migrations here are applied by hand, so a frontend deploy
 *  can land before the DDL does, and a bare PostgREST error next to a step
 *  that still will not open tells the operator nothing they can act on. */
export function starterSkipErrorMessage(e: unknown): string {
  if (isMissingStarterSkipColumn(e)) {
    return 'This database has not run the starter-soil migration yet '
      + '(20261007120000), so the exemption cannot be recorded. Paste the Amazon '
      + 'tracking number instead, or apply the migration.';
  }
  return (e as Error).message;
}
