import { supabase } from './supabase';
import { logAction } from './activityLog';
import { cancelOrder } from './orders';
import { withdrawOrderFromQueue } from './fulfillment';

/** Nothing else should be on its way to a customer we are paying back.
 *
 *  Until now the refund workflow only ever acted on ONE order, and only at the
 *  very end: executeRefund pulled the refunded order's row out of the
 *  fulfillment queue once the money had actually moved. Everything else the
 *  customer had open kept moving. A queued warranty replacement showed up as a
 *  yellow "hold before refunding" banner on the card with a manual Hold button
 *  next to it — which is a reminder, not a control, and the Hold it offered
 *  wrote a replacement_state the database does not even accept.
 *
 *  So a customer could be three weeks into a refund and still have a machine
 *  picked, boxed and labelled for them.
 *
 *  This module closes that: the moment a refund card enters the workflow, every
 *  order that customer still has in flight — sales and replacements alike — is
 *  pulled out of the fulfillment queue and cancelled.
 *
 *  Two deliberate limits:
 *
 *    - It is keyed on EMAIL, exact after trim + lowercase. A name is not
 *      identity (half the order book shares a first name) and refund_approvals
 *      has no customer_id, so email is the only signal the card and the order
 *      actually share. A card with no email cancels nothing.
 *
 *    - "In flight" is judged conservatively, because every cancel here gives
 *      stock back. See stillInFlight().
 *
 *  It is deliberately best-effort at the call site: a refund card must be
 *  creatable whether or not the cancels land. What it must never do is fail
 *  silently, so every order it could not cancel comes back in `failed` for the
 *  operator to see, and the whole run is written to the activity log.
 */

/** The order columns this needs. Kept narrow so the query is explicit about
 *  what the decision is actually made on. */
export type AutoCancellableOrder = {
  id: string;
  order_ref: string;
  kind: string | null;
  status: string;
  replacement_state: 'ready' | 'awaiting' | 'held' | null;
  linked_ticket_id: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  tracking_num: string | null;
};

export const AUTO_CANCEL_COLUMNS =
  'id, order_ref, kind, status, replacement_state, linked_ticket_id, shipped_at, delivered_at, tracking_num';

/** A sale is in flight in any of these. 'approved' is included on purpose: it
 *  is the state that FIRES auto_enqueue_approved_order, so an approved order is
 *  precisely the one already sitting in the fulfillment queue with a machine
 *  reserved against it — the case this whole feature exists for. */
export const LIVE_SALE_STATUSES = ['pending', 'flagged', 'held', 'approved'] as const;

/** Ticket states that mean the replacement attached to them is already
 *  resolved — the box went out, or the case is shut. */
export const FINISHED_TICKET_STATUSES = ['closed', 'replacement_sent'] as const;

/** Has this order definitely not gone out the door yet?
 *
 *  Three independent shipped-signals, because no single one is reliable:
 *
 *    - shipped_at / delivered_at — the honest answer when they are set, and
 *      they usually are on a sale.
 *    - tracking_num — per the operator, tracking_num IS NOT NULL ⇒ shipped.
 *      Backfilled replacements have a tracking number and nothing else.
 *    - the linked ticket, for replacements only. shipped_at is almost never
 *      stamped on a replacement (only the 'replacement_sent' ticket status
 *      writes it, and effectively no ticket used it), so a replacement whose
 *      ticket is closed or marked replacement_sent is treated as gone. This is
 *      the same guard useQueuedReplacements applies before it warns, and the
 *      reason it matters here is heavier: cancelling a replacement releases its
 *      reserved unit back to sellable stock and restores the parts it consumed.
 *      Doing that to a machine that physically shipped in June invents a unit
 *      and a lid that do not exist.
 */
function stillInFlight(o: AutoCancellableOrder, finishedTicketIds: Set<string>): boolean {
  if (o.status === 'cancelled') return false;
  if (o.shipped_at || o.delivered_at || o.tracking_num) return false;
  if (o.kind === 'replacement') {
    return !(o.linked_ticket_id && finishedTicketIds.has(o.linked_ticket_id));
  }
  return (LIVE_SALE_STATUSES as readonly string[]).includes(o.status);
}

/** Everything of a customer's that a refund should take down. Pure, so the
 *  rule above is testable without a database. */
export function ordersToAutoCancel(
  orders: AutoCancellableOrder[],
  finishedTicketIds: Set<string>,
): AutoCancellableOrder[] {
  return orders.filter(o => stillInFlight(o, finishedTicketIds));
}

export type AutoCancelledOrder = {
  order_ref: string;
  kind: string | null;
  /** True when a live fulfillment_queue row was pulled as part of the cancel —
   *  i.e. this one really was on its way out. */
  wasQueued: boolean;
};

export type AutoCancelOutcome = {
  cancelled: AutoCancelledOrder[];
  failed: Array<{ order_ref: string; message: string }>;
  /** The card carried no email, so no customer could be identified. */
  skippedNoEmail: boolean;
};

const EMPTY: AutoCancelOutcome = { cancelled: [], failed: [], skippedNoEmail: false };

/** Which of these tickets are finished, asked only about the ids we hold. */
async function finishedTicketIdsAmong(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase
    .from('service_tickets')
    .select('id, status')
    .in('id', ids);
  if (error) throw new Error(`Could not check the linked tickets: ${error.message}`);
  // The status test is applied here rather than as a second server-side filter.
  // The ticket status taxonomy has drifted between the database and this app
  // before, and a filter the database rejects fails the WHOLE query — which
  // would come back "no finished tickets" and cancel replacements that shipped
  // in June. Asking for the rows and deciding locally cannot fail that way.
  const finished = new Set<string>(FINISHED_TICKET_STATUSES);
  return new Set(
    (data ?? [])
      .map(t => t as { id: string; status: string | null })
      .filter(t => t.status != null && finished.has(t.status))
      .map(t => t.id),
  );
}

/** One order's worth of work: out of the queue, then cancelled.
 *
 *  Queue first, and it matters. cancelOrder is explicitly not responsible for
 *  anything queue-side, so cancelling without withdrawing leaves a
 *  fulfillment_queue row pointing at a cancelled order with a machine still
 *  reserved to it — exactly the split-brain that left #1214 sitting Held in
 *  Sales and step-1 Ready-to-ship in Fulfillment for 29 days.
 *
 *  withdrawOrderFromQueue returns false (rather than throwing) when the order
 *  was never queued, which is the common case. */
async function takeDown(o: AutoCancellableOrder, reason: string): Promise<AutoCancelledOrder> {
  const wasQueued = await withdrawOrderFromQueue(o.id, reason);
  await cancelOrder(o.id, reason);
  return { order_ref: o.order_ref, kind: o.kind, wasQueued };
}

/** Cancel everything a customer still has in flight, because a refund card was
 *  just opened for them.
 *
 *  Each order is handled independently: one that refuses (an RLS-blocked
 *  delete, a replacement whose stock will not release) is recorded in `failed`
 *  and the rest still go. A half-done run is strictly better than one that
 *  stops at the first problem and leaves the operator guessing which orders are
 *  still live. */
export async function cancelOpenOrdersForRefund(opts: {
  refundId: string;
  customerEmail: string | null | undefined;
  customerName: string | null | undefined;
}): Promise<AutoCancelOutcome> {
  const email = (opts.customerEmail ?? '').trim().toLowerCase();
  if (!email) return { ...EMPTY, skippedNoEmail: true };

  const { data, error } = await supabase
    .from('orders')
    .select(AUTO_CANCEL_COLUMNS)
    .ilike('customer_email', email)
    .neq('status', 'cancelled');
  if (error) throw new Error(`Could not read this customer's orders: ${error.message}`);

  const rows = (data ?? []) as AutoCancellableOrder[];
  const ticketIds = Array.from(new Set(
    rows.filter(o => o.kind === 'replacement' && o.linked_ticket_id)
      .map(o => o.linked_ticket_id as string),
  ));
  const targets = ordersToAutoCancel(rows, await finishedTicketIdsAmong(ticketIds));
  if (targets.length === 0) return EMPTY;

  const who = (opts.customerName ?? '').trim() || email;
  // Read by someone standing in Sales › Cancelled who never saw the refund
  // card, so it has to name the cause, not just the effect.
  const reason = `Auto-cancelled: a refund is in progress for ${who}. `
    + `Nothing ships to a customer we are paying back.`;

  const outcome: AutoCancelOutcome = { cancelled: [], failed: [], skippedNoEmail: false };
  for (const o of targets) {
    try {
      outcome.cancelled.push(await takeDown(o, reason));
    } catch (e) {
      outcome.failed.push({ order_ref: o.order_ref, message: (e as Error).message });
    }
  }

  await logAction('refund_auto_cancelled', opts.refundId, summariseAutoCancel(outcome));
  return outcome;
}

/** One line describing a run — for the activity log and the operator's banner. */
export function summariseAutoCancel(outcome: AutoCancelOutcome): string {
  const done = outcome.cancelled.map(c => c.order_ref).join(', ');
  const bad = outcome.failed.map(f => `${f.order_ref} (${f.message})`).join(', ');
  if (!done && !bad) return 'nothing open to cancel';
  const parts: string[] = [];
  if (done) parts.push(`cancelled ${outcome.cancelled.length}: ${done}`);
  if (bad) parts.push(`COULD NOT CANCEL ${outcome.failed.length}: ${bad}`);
  return parts.join(' · ');
}

/** The same run, phrased for the operator who just made the card. Null when
 *  there is nothing worth interrupting them about. */
export function autoCancelBanner(outcome: AutoCancelOutcome): string | null {
  if (outcome.failed.length === 0 && outcome.cancelled.length === 0) return null;
  const done = outcome.cancelled.length
    ? `Cancelled ${outcome.cancelled.length} order${outcome.cancelled.length > 1 ? 's' : ''} still in flight for this customer: `
      + outcome.cancelled.map(c => c.order_ref).join(', ') + '.'
    : '';
  const bad = outcome.failed.length
    ? ` Could not cancel ${outcome.failed.map(f => f.order_ref).join(', ')} — cancel `
      + `${outcome.failed.length > 1 ? 'them' : 'it'} by hand before this refund goes out.`
    : '';
  return (done + bad).trim();
}
