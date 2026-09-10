import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Do not ship a machine to someone we have already paid back.
 *
 *  Nothing in makeLILA connected a refund to the order it refunded. The FK
 *  exists — refund_approvals.order_id — but every caller deliberately left it
 *  null, because a return's original_order_ref is human text ("#1107", "1216",
 *  "R-0043", "I don't know, please ask Edward") and not a UUID. So:
 *
 *    - Sales showed a refunded customer's open order exactly like any other.
 *    - Confirming that order fires auto_enqueue_approved_order, which drops a
 *      row into fulfillment_queue with nothing to say the money already went
 *      back — and the queue ships what it is handed.
 *
 *  This module is the missing link. It matches refunds to orders on the UUID
 *  when it is there and on a normalised human ref or the customer's email when
 *  it isn't, and grades the match:
 *
 *    'order'    — THIS order was refunded. Shipping it is a second loss.
 *                 enqueueForFulfillment refuses it.
 *    'ref'      — a refund names this order's number but was filed by someone
 *                 who does not look like this customer. A typed number is not
 *                 identity, so this warns and never blocks.
 *    'customer' — a DIFFERENT order of theirs was refunded. Often legitimate
 *                 (they bought again), so this warns and never blocks.
 */

export type RefundMark = {
  id: string;
  status: string;
  /** The FK, when a caller managed to resolve one. Null on all 18 live rows. */
  order_id: string | null;
  customer_email: string | null;
  /** Who the refund was filed for. The only identity signal shared with an
   *  order when the two rows carry different email addresses. */
  customer_name: string | null;
  /** The linked return's original_order_ref — free text off a public form. */
  order_ref: string | null;
  refunded_at: string | null;
  refund_amount_usd: number | null;
};

export type FlaggableOrder = {
  id: string;
  order_ref: string;
  customer_email: string | null;
  customer_name: string | null;
};

type ResolvableOrder = FlaggableOrder & { kind?: string | null };

export type RefundFlag = {
  /** 'order'    — this very order was refunded.
   *  'ref'      — a refund names this order's number, but was filed by someone
   *               who does not look like this customer. Cannot be trusted
   *               either way, so it warns and never blocks.
   *  'customer' — a different order of theirs was refunded. */
  level: 'order' | 'ref' | 'customer';
  /** Who the refund was filed for — shown on a 'ref' warning, where the whole
   *  point is that it is not obviously this order's customer. */
  refundCustomer: string | null;
  /** True once the payout actually happened; false while the card is in review. */
  settled: boolean;
  refundId: string;
  refundedAt: string | null;
  amountUsd: number | null;
};

/** The refund statuses that bear on whether we should ship. 'denied' is an
 *  explicit decision NOT to refund, so it must not stand in the way of a
 *  shipment; 'closed' is history. Listed positively rather than as a
 *  not-in filter: this list is what the server is asked for, and a filter the
 *  server rejects would fail the whole query — which fails open, silently
 *  turning the guard off. */
const SHIPPING_RELEVANT_STATUSES = [
  'submitted', 'manager_review', 'finance_review', 'refund_queue', 'refunded',
];

function bearsOnShipping(status: string): boolean {
  return SHIPPING_RELEVANT_STATUSES.includes(status);
}

/** Reduce a human order reference to something comparable. Shopify writes
 *  "#1134" and customers type "1134" into the return form — one order, so the
 *  hash goes. Everything else is kept.
 *
 *  In particular INV- is NOT stripped. It reads like a prefix on the same
 *  number, but the invoice importer numbers its own series: all 14 INV- orders
 *  in production collide with a #-series order belonging to a DIFFERENT
 *  customer (INV-1174 is the Amaros, #1174 is Joseph Thavundayil). Stripping it
 *  merged every one of those pairs.
 *
 *  Returns '' for anything that names no order, and '' never matches. */
export function normaliseOrderRef(ref: string | null | undefined): string {
  const trimmed = (ref ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  const bare = trimmed.replace(/^#/, '').trim();
  // Free text from the return form ("I don't know, please ask Edward") is not
  // a reference. Accept only a ref-shaped token: letters and hyphens, then
  // digits — '1216', 'r-0043', 'inv-1174', 'inv-r1205'.
  if (!/^[a-z-]*\d+$/.test(bare)) return '';
  return bare;
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'and']);

/** The words in a name that carry identity. Punctuation and joint-account
 *  scaffolding go ("Chad & Sarah Lockhart Anne" → chad, sarah, lockhart, anne),
 *  as do honorifics and initials. */
function nameTokens(name: string | null | undefined): Set<string> {
  return new Set(
    (name ?? '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !HONORIFICS.has(t)),
  );
}

/** Do two names look like the same person? Two shared words, not one: half the
 *  order book shares a first name with somebody ('Michael Haywood' /
 *  'Michael Madigan' are two customers who both hold a ...174-shaped ref).
 *  Two is enough for the real pairs — 'Brent Neave' twice over, 'Chad Lockhart'
 *  inside 'Chad & Sarah Lockhart Anne'.
 *
 *  Deliberately used ONLY to corroborate a ref match, never to find one. */
function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = nameTokens(a);
  if (left.size === 0) return false;
  let shared = 0;
  for (const token of nameTokens(b)) if (left.has(token)) shared++;
  return shared >= 2;
}

function sameCustomer(order: FlaggableOrder, mark: RefundMark): boolean {
  const a = (order.customer_email ?? '').trim().toLowerCase();
  const b = (mark.customer_email ?? '').trim().toLowerCase();
  return a !== '' && a === b;
}

/** How strongly a refund card points at THIS order.
 *
 *  The FK is a decision someone made and is taken at face value. A human ref is
 *  a string typed on a public form, and a bare number is not identity: Cheryl
 *  Lemieux's return said '1216', which six weeks later became Raymond Keetch's
 *  order number. So a ref match only rises to 'order' when the customer
 *  corroborates it — same email, or a name that agrees. */
function orderMatchLevel(order: FlaggableOrder, mark: RefundMark): 'order' | 'ref' | null {
  if (mark.order_id) return mark.order_id === order.id ? 'order' : null;
  const a = normaliseOrderRef(order.order_ref);
  if (a === '' || a !== normaliseOrderRef(mark.order_ref)) return null;
  return sameCustomer(order, mark) || namesAgree(order.customer_name, mark.customer_name)
    ? 'order'
    : 'ref';
}

function toFlag(mark: RefundMark, level: RefundFlag['level']): RefundFlag {
  return {
    level,
    refundCustomer: mark.customer_name,
    settled: mark.status === 'refunded' || mark.refunded_at != null,
    refundId: mark.id,
    refundedAt: mark.refunded_at,
    amountUsd: mark.refund_amount_usd,
  };
}

/** Strongest first. 'ref' outranks 'customer': it points at this very order
 *  number, where 'customer' is about a different order altogether. */
const LEVEL_RANK: Record<RefundFlag['level'], number> = { order: 2, ref: 1, customer: 0 };

/** The strongest refund signal against one order, or null if it is clean.
 *  Order-level beats customer-level; within a level, a settled refund beats a
 *  card still in review. */
export function refundFlagForOrder(order: FlaggableOrder, marks: RefundMark[]): RefundFlag | null {
  let best: RefundFlag | null = null;
  for (const mark of marks) {
    if (!bearsOnShipping(mark.status)) continue;
    const level = orderMatchLevel(order, mark) ?? (sameCustomer(order, mark) ? 'customer' : null);
    if (!level) continue;
    const flag = toFlag(mark, level);
    if (!best) { best = flag; continue; }
    if (LEVEL_RANK[flag.level] > LEVEL_RANK[best.level]) { best = flag; continue; }
    if (best.level === flag.level && !best.settled && flag.settled) best = flag;
  }
  return best;
}

/** refundFlagForOrder across a whole list, keyed by order id. Clean orders are
 *  absent rather than mapped to null, so `index.has(id)` reads as "flagged". */
export function indexRefundFlags(
  orders: FlaggableOrder[],
  marks: RefundMark[],
): Map<string, RefundFlag> {
  const index = new Map<string, RefundFlag>();
  for (const order of orders) {
    const flag = refundFlagForOrder(order, marks);
    if (flag) index.set(order.id, flag);
  }
  return index;
}

const MARK_COLUMNS = 'id, status, order_id, customer_email, customer_name, refunded_at, refund_amount_usd, returns(original_order_ref)';

type MarkQueryRow = Omit<RefundMark, 'order_ref'> & {
  returns: { original_order_ref: string | null } | { original_order_ref: string | null }[] | null;
};

function toMark(row: MarkQueryRow): RefundMark {
  const linked = Array.isArray(row.returns) ? row.returns[0] : row.returns;
  return {
    id: row.id,
    status: row.status,
    order_id: row.order_id,
    customer_email: row.customer_email,
    customer_name: row.customer_name,
    order_ref: linked?.original_order_ref ?? null,
    refunded_at: row.refunded_at,
    refund_amount_usd: row.refund_amount_usd,
  };
}

/** Every refund card that bears on shipping, as one-shot query — for callers
 *  outside React (the enqueue guard, the refund executor). */
export async function fetchRefundMarks(): Promise<RefundMark[]> {
  const { data, error } = await supabase
    .from('refund_approvals')
    .select(MARK_COLUMNS)
    .in('status', SHIPPING_RELEVANT_STATUSES);
  if (error) throw new Error(`Could not read refunds: ${error.message}`);
  return ((data ?? []) as MarkQueryRow[]).map(toMark);
}

/** The refund signal against one order, fetched fresh. Used by the enqueue
 *  guard, where a stale realtime cache would be the wrong thing to trust. */
export async function refundFlagForOrderId(orderId: string): Promise<RefundFlag | null> {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, order_ref, customer_email, customer_name')
    .eq('id', orderId)
    .single();
  if (error || !order) return null;
  return refundFlagForOrder(order as FlaggableOrder, await fetchRefundMarks());
}

/** Resolve the human ref a return carries into the orders row it names, so a
 *  new refund card can carry the real FK. Falls back to the customer's single
 *  matching order; returns null rather than guess between several.
 *
 *  Never throws. This enriches a refund card — the card is the operator's work
 *  and must be creatable whether or not we can pin down the order, exactly as
 *  defaultRefundAmountFromInvoice treats a failed invoice lookup. */
export async function resolveRefundOrderId(
  email: string | null | undefined,
  orderRef: string | null | undefined,
): Promise<string | null> {
  const ref = normaliseOrderRef(orderRef);
  const clean = (email ?? '').trim().toLowerCase();
  if (!ref && !clean) return null;

  let rows: ResolvableOrder[];
  try {
    const { data } = await supabase
      .from('orders')
      .select('id, order_ref, customer_email, kind')
      .or([
        ref ? `order_ref.ilike.%${ref}` : null,
        clean ? `customer_email.ilike.${clean}` : null,
      ].filter(Boolean).join(','));
    rows = (data ?? []) as ResolvableOrder[];
  } catch (e) {
    console.warn('resolving the refunded order failed (non-fatal):', (e as Error).message);
    return null;
  }

  if (ref) {
    const onRef = rows.filter(r => normaliseOrderRef(r.order_ref) === ref);
    // An unqualified ref can collide across customers ("#1134" vs "INV-1134"
    // are one order, but two customers can hold refs that normalise alike).
    // Narrow by email when we have one, and never pick from an ambiguous set.
    const narrowed = clean
      ? onRef.filter(r => (r.customer_email ?? '').trim().toLowerCase() === clean)
      : onRef;
    const candidates = narrowed.length ? narrowed : onRef;
    if (candidates.length === 1) return candidates[0].id;
    return null;
  }
  // No ref to go on — fall back to the customer's single SALE. Sales only:
  // Lily Xu's one remaining order is a warranty replacement, and pinning her
  // refund to it would block a machine she is owed. A refund is always against
  // something that was paid for.
  const byEmail = rows.filter(r =>
    (r.customer_email ?? '').trim().toLowerCase() === clean && r.kind !== 'replacement');
  return byEmail.length === 1 ? byEmail[0].id : null;
}

/** Live refund marks for the UI, so Sales and the fulfillment queue can badge
 *  a refunded customer's order the moment a refund lands. */
export function useRefundMarks(): { marks: RefundMark[]; loading: boolean } {
  const [marks, setMarks] = useState<RefundMark[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const rows = await fetchRefundMarks();
        if (!cancelled) setMarks(rows);
      } catch (e) {
        console.warn('refund marks load failed (non-fatal):', (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load().then(() => {
      if (cancelled) return;
      // Refetch rather than patch from the payload: a mark needs the joined
      // return's order_ref, which the change payload does not carry. Refetching
      // also survives a dropped socket, which a patch-only hook does not.
      channel = supabase
        .channel('refund_approvals:marks')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'refund_approvals' }, () => { void load(); })
        .subscribe();
    });

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, []);

  return { marks, loading };
}

/** The one-line warning an operator reads on a badge or in a blocked action. */
export function refundFlagLabel(flag: RefundFlag): string {
  if (flag.level === 'order') return flag.settled ? 'REFUNDED' : 'REFUND PENDING';
  if (flag.level === 'ref') return 'CHECK REFUND';
  return flag.settled ? 'CUSTOMER REFUNDED' : 'REFUND OPEN';
}

export function refundFlagTitle(flag: RefundFlag): string {
  const amount = flag.amountUsd != null ? `$${Number(flag.amountUsd).toFixed(2)}` : 'a refund';
  const when = flag.refundedAt ? ` on ${flag.refundedAt.slice(0, 10)}` : '';
  if (flag.level === 'ref') {
    const who = flag.refundCustomer ?? 'another customer';
    return `A refund for ${who} (${amount}${when}) names this order number, but was filed `
      + `against a different customer. Check which order it was really for before shipping.`;
  }
  if (flag.level === 'order') {
    return flag.settled
      ? `This order was refunded — ${amount} paid back${when}. Do not ship it.`
      : `A refund for this order is in review (${amount}). Check before shipping.`;
  }
  return flag.settled
    ? `This customer was refunded ${amount}${when} on another order. Check this one is still owed.`
    : `This customer has a refund in review (${amount}) on another order.`;
}
