import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type OrderStatus = 'pending' | 'approved' | 'flagged' | 'held';

export type LineItem =
  // Legacy Shopify-synced sale line — do not add new sale shapes here; extend the 'part'/'unit' variants instead.
  | { sku: string; name: string; qty: number; price_usd: number }
  | { kind: 'part'; part_id: string; sku: string; name: string; qty: number; cost_per_unit_usd: number }
  | { kind: 'unit'; unit_serial: string; batch: string; name: string; qty: 1; cost_usd: number };

export type OrderKind = 'sale' | 'replacement';

export type OrderNote = {
  id: number;
  order_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
};

export type Order = {
  id: string;
  order_ref: string;
  kind: OrderKind;
  status: OrderStatus;
  // Canonical FK to customers.id (backlog #68). Auto-populated by the
  // orders_auto_customer_id trigger; sync-shopify-orders doesn't need to
  // set it explicitly. Use this for any "the customer for this order"
  // lookup in preference to fuzzy email/name match.
  customer_id: string | null;
  linked_ticket_id: string | null;
  // Backlog #71 — when set, this order is waiting on an inbound batch
  // (e.g. P100X currently in production in China). UI shows it grouped
  // in the Replacement tab under "Awaiting batch" with the batch's
  // expected arrival.
  awaiting_batch_id: string | null;
  // Replacement tagging + pending replacements (spec 2026-06-08). 'ready' =
  // every line item is in stock / a unit is ready; 'awaiting' = blocked on an
  // out-of-stock part or a pending unit batch; 'held' = paused by an operator
  // while a refund/return is in progress (#83). Drives the Ready / Awaiting /
  // Held split in Order Review > Replacement. Null for non-replacement.
  replacement_state: 'ready' | 'awaiting' | 'held' | null;
  held_reason: string | null;
  cogs_usd: number | null;
  shipping_cost_usd: number | null;
  shipped_at: string | null;
  delivered_at: string | null;
  // Backlog #55 follow-up — carrier tracking. Populated by the Fulfillment
  // step OR backfilled from the fulfillment Excel for replacement orders.
  // Per operator: tracking_num IS NOT NULL ⇒ shipped, NULL ⇒ to be shipped.
  tracking_num: string | null;
  carrier: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  quo_thread_url: string | null;
  address_line: string | null;
  address_line2: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  address_verdict: 'house' | 'apt' | 'remote' | 'condo';
  // Urban/suburban vs rural area classification (separate from address_verdict's
  // dwelling type). area_type_source tracks provenance: 'auto' (postal-code
  // guess on sync), 'verified' (set by the Verify-address step via Claude), or
  // 'manual' (operator override). null = unclassified.
  area_type: 'urban' | 'suburban' | 'rural' | null;
  area_type_source: string;
  address_verified_at: string | null;
  address_match: 'match' | 'mismatch' | 'unverifiable' | null;
  address_google_formatted: string | null;
  address_google_postal: string | null;
  address_customer_postal: string | null;
  address_claude_verdict: 'plausible' | 'implausible' | 'unknown' | null;
  address_claude_notes: string | null;
  address_claude_postal: string | null;
  address_confirmed_at: string | null;
  address_confirmation_sent_at: string | null;
  freight_estimate_usd: number;
  freight_threshold_usd: number;
  // What Shopify recorded the customer paying for shipping. Distinct from
  // freight_estimate_usd (the operator-editable carrier-quote field).
  // Editing the estimate must NOT change this. Backlog #65.
  customer_paid_shipping_usd: number | null;
  // Where the freight estimate value came from (backlog #17): 'shopify'
  // on initial sync, flips to 'manual' on operator edit. Future: 'clickship'
  // / 'freightcom' once those integrations land (#19).
  freight_estimate_source: string;
  // *_usd fields hold the amount in the order's own `currency`, despite the historical `_usd` naming — CAD orders are NOT in USD.
  currency: string;
  total_usd: number;
  subtotal_usd: number | null;
  tax_usd: number | null;
  tax_lines: Array<{ title: string; rate: number; amount_usd: number }> | null;
  discount_total_usd: number | null;
  discount_codes: string[] | null;
  payment_methods: string[] | null;
  financial_status: string | null;
  shipping_line_title: string | null;
  line_items: LineItem[];
  sales_confirmed_fit: boolean;
  dispositioned_by: string | null;
  dispositioned_at: string | null;
  created_at: string;
  placed_at: string | null;
};

/** Type guard for replacement-shaped line items. */
export function isReplacementLine(li: LineItem): li is Extract<LineItem, { kind: 'part' | 'unit' }> {
  return 'kind' in li && (li.kind === 'part' || li.kind === 'unit');
}

export type UrgencySeverity = 'ok' | 'urgent' | 'overdue';

export function orderUrgency(placed_at: string | null): {
  days: number | null;
  severity: UrgencySeverity;
  label: string;
} {
  if (!placed_at) return { days: null, severity: 'ok', label: '' };
  const placed = new Date(placed_at); placed.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((today.getTime() - placed.getTime()) / 86_400_000));
  if (days > 4)  return { days, severity: 'overdue', label: `${days}d OVERDUE` };
  if (days >= 3) return { days, severity: 'urgent',  label: `${days}d URGENT` };
  return { days, severity: 'ok', label: days === 0 ? 'today' : `${days}d` };
}

/** Due date for the 2-day order-confirmation SLA: placed_at + 2 days.
 *  Severity is keyed off days-since-placement (not days-until-due) so the pill
 *  turns yellow the moment the SLA is missed and red when >4 days have passed. */
export function orderDue(placed_at: string | null): {
  dueDate: Date | null;
  dueLabel: string;
  severity: UrgencySeverity;
} {
  if (!placed_at) return { dueDate: null, dueLabel: '—', severity: 'ok' };
  const placed = new Date(placed_at); placed.setHours(0, 0, 0, 0);
  const due = new Date(placed); due.setDate(due.getDate() + 2);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((today.getTime() - placed.getTime()) / 86_400_000));
  const severity: UrgencySeverity = days > 4 ? 'overdue' : days >= 3 ? 'urgent' : 'ok';
  return { dueDate: due, dueLabel: due.toLocaleDateString('en-US'), severity };
}

const ACTION_TYPE: Record<Exclude<OrderStatus, 'pending'>, string> = {
  approved: 'order_approve',
  flagged:  'order_flag',
  held:     'order_hold',
};

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('orders: not authenticated');
  return data.user.id;
}

export async function disposition(
  order: Pick<Order, 'id' | 'order_ref' | 'customer_name'>,
  status: Exclude<OrderStatus, 'pending'>,
  reason?: string,
): Promise<void> {
  const userId = await currentUserId();

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      dispositioned_by: userId,
      dispositioned_at: new Date().toISOString(),
    })
    .eq('id', order.id);
  if (error) throw error;

  await logAction(ACTION_TYPE[status], order.order_ref, reason ?? order.customer_name);
}

export async function needInfo(
  order: Pick<Order, 'id' | 'order_ref' | 'customer_name'>,
  note?: string,
): Promise<void> {
  await logAction('order_need_info', order.order_ref, note ?? order.customer_name);
}

export async function addOrderNote(
  orderId: string,
  authorName: string,
  body: string,
): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('order_notes').insert({
    order_id: orderId,
    author_id: userId,
    author_name: authorName,
    body,
  });
  if (error) throw error;
}

export async function setSalesConfirmedFit(id: string, value: boolean): Promise<void> {
  const { error } = await supabase.from('orders').update({ sales_confirmed_fit: value }).eq('id', id);
  if (error) throw error;
}

export type AreaType = 'urban' | 'suburban' | 'rural';

/** Full labels for the detail card dropdown. */
export const AREA_TYPE_LABEL: Record<AreaType, string> = {
  urban:    'Urban',
  suburban: 'Suburban',
  rural:    'Rural / Remote',
};

/** Short labels for the compact list-row tag. */
export const AREA_TYPE_TAG: Record<AreaType, string> = {
  urban:    'Urban',
  suburban: 'Suburban',
  rural:    'Rural',
};

/** Operator override of the auto-guessed area type. Flips the source to
 *  'manual' so a later Shopify re-sync won't clobber the choice. Passing null
 *  clears it back to unclassified (and back to auto provenance). */
export async function setAreaType(id: string, value: AreaType | null): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ area_type: value, area_type_source: value ? 'manual' : 'auto' })
    .eq('id', id);
  if (error) throw error;
  await logAction('area_type_set', id, value ?? 'unclassified');
}

export async function updateFreightEstimate(id: string, amount: number): Promise<void> {
  // Backlog #17 — operator edit flips the source to 'manual' so the FreightCard
  // can render a "(operator edit)" tag and reporting can distinguish synced
  // values from manual overrides.
  const { error } = await supabase
    .from('orders')
    .update({ freight_estimate_usd: amount, freight_estimate_source: 'manual' })
    .eq('id', id);
  if (error) throw error;
}

export type VerifyAddressResult = {
  match: 'match' | 'mismatch' | 'unverifiable';
  customer_postal: string | null;
  google_postal: string | null;
  google_formatted: string | null;
  // Area type the verify step classified (urban/suburban/rural), written back
  // to the order with source 'verified'. null if it couldn't be determined.
  area_type: 'urban' | 'suburban' | 'rural' | null;
  // Set when Google Address Validation failed (quota/billing/network) and we
  // degraded to 'unverifiable' rather than aborting. Lets the operator see the
  // verdict was downgraded for an infra reason, not a bad address.
  google_error?: string | null;
};

/** supabase-js collapses any non-2xx edge-function response into a generic
 *  "Edge Function returned a non-2xx status code"; the real `{ error }` JSON the
 *  function returned is on error.context (a Response). Pull it out so operators
 *  see the actual cause instead of the opaque default. */
async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch { /* body wasn't JSON — fall through to text */ }
    try {
      const text = await ctx.text();
      if (text) return text.slice(0, 400);
    } catch { /* ignore */ }
  }
  return (error as Error)?.message ?? 'Edge function call failed';
}

export async function confirmAddress(orderId: string): Promise<{ order_ref: string; already_confirmed: boolean }> {
  const { data, error } = await supabase.functions.invoke<{ order_ref: string; already_confirmed: boolean }>(
    'confirm-address',
    { body: { order_id: orderId } },
  );
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Empty response from confirm-address');
  return data;
}

export async function verifyAddress(orderId: string): Promise<VerifyAddressResult> {
  const { data, error } = await supabase.functions.invoke<VerifyAddressResult>(
    'verify-address',
    { body: { order_id: orderId } },
  );
  if (error) throw new Error(await functionErrorMessage(error));
  if (!data) throw new Error('Empty response from verify-address');
  await logAction('address_verified', orderId, data.match);
  return data;
}

function applyChange(cache: Order[], payload: { eventType: string; new: Order | null; old: { id: string } | null }): Order[] {
  if (payload.eventType === 'DELETE' && payload.old) {
    return cache.filter(o => o.id !== payload.old!.id);
  }
  if (payload.new) {
    const existing = cache.findIndex(o => o.id === payload.new!.id);
    if (existing >= 0) {
      const next = [...cache];
      next[existing] = payload.new;
      return next;
    }
    return [payload.new, ...cache];
  }
  return cache;
}

export function useOrders(): {
  all: Order[];
  pending: Order[];
  held: Order[];
  flagged: Order[];
  approved: Order[];
  /** All kind='replacement' orders in the active set. Surfaced in
   *  Order Review's "Replacement" tab so they don't dilute the
   *  Pending/Held/Flagged/Confirmed sales tabs. */
  replacement: Order[];
  loading: boolean;
} {
  const [cache, setCache] = useState<Order[]>([]);
  const [fulfilledOrderIds, setFulfilledOrderIds] = useState<Set<string>>(new Set());
  // Customer-name match (lowercased) for any shipped unit. Used as a second
  // signal: an order whose customer has a shipped unit is effectively
  // fulfilled even if fulfillment_queue never advanced to step 6 (e.g.
  // orders shipped via the legacy Excel workflow before queue rows existed).
  const [shippedCustomers, setShippedCustomers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ordersChannel: RealtimeChannel | null = null;
    let queueChannel: RealtimeChannel | null = null;
    let unitsChannel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const [
        { data: ordersData, error: ordersErr },
        { data: queueData, error: queueErr },
        { data: unitsData, error: unitsErr },
      ] = await Promise.all([
        supabase.from('orders').select('*').order('created_at', { ascending: false }),
        supabase.from('fulfillment_queue').select('order_id, step, fulfilled_at'),
        supabase.from('units').select('customer_name, status').eq('status', 'shipped'),
      ]);

      if (cancelled) return;
      if (!ordersErr && ordersData) setCache(ordersData as Order[]);
      if (!queueErr && queueData) {
        setFulfilledOrderIds(new Set(
          (queueData as { order_id: string; step: number; fulfilled_at: string | null }[])
            .filter(q => q.step === 6 || q.fulfilled_at !== null)
            .map(q => q.order_id)
        ));
      }
      if (!unitsErr && unitsData) {
        setShippedCustomers(new Set(
          (unitsData as { customer_name: string | null; status: string }[])
            .map(u => (u.customer_name ?? '').toLowerCase().trim())
            .filter(Boolean)
        ));
      }
      setLoading(false);

      ordersChannel = supabase
        .channel('orders:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          (payload) => {
            setCache(prev => applyChange(prev, {
              eventType: payload.eventType,
              new: payload.new as Order | null,
              old: payload.old as { id: string } | null,
            }));
          },
        )
        .subscribe();

      queueChannel = supabase
        .channel('orders:fulfillment_queue')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue' },
          (payload) => {
            const row = (payload.new ?? payload.old) as { order_id?: string; step?: number; fulfilled_at?: string | null } | null;
            if (!row?.order_id) return;
            setFulfilledOrderIds(prev => {
              const next = new Set(prev);
              const isFulfilled = (payload.new as { step?: number; fulfilled_at?: string | null } | null);
              if (isFulfilled && (isFulfilled.step === 6 || isFulfilled.fulfilled_at)) {
                next.add(row.order_id!);
              } else {
                next.delete(row.order_id!);
              }
              return next;
            });
          },
        )
        .subscribe();

      unitsChannel = supabase
        .channel('orders:units')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'units' },
          (payload) => {
            const row = (payload.new ?? payload.old) as { customer_name?: string | null; status?: string } | null;
            const name = (row?.customer_name ?? '').toLowerCase().trim();
            if (!name) return;
            setShippedCustomers(prev => {
              const next = new Set(prev);
              const newStatus = (payload.new as { status?: string } | null)?.status;
              if (newStatus === 'shipped') next.add(name);
              return next;
            });
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (ordersChannel) void ordersChannel.unsubscribe();
      if (queueChannel) void queueChannel.unsubscribe();
      if (unitsChannel) void unitsChannel.unsubscribe();
    };
  }, []);

  return useMemo(() => {
    // Exclude orders that are fulfilled, by either signal:
    //   (a) fulfillment_queue row reached step 6 / has fulfilled_at, OR
    //   (b) customer has a shipped unit (catches legacy Excel-only shipments
    //       where the queue row was never created or advanced).
    const active = cache.filter(o => {
      if (fulfilledOrderIds.has(o.id)) return false;
      // Never hide replacement orders by the shipped-customer name check —
      // a returning customer's replacement must always be visible in Order Review.
      if (o.kind !== 'replacement' && shippedCustomers.has(o.customer_name.toLowerCase().trim())) return false;
      return true;
    });
    // Replacement orders get their own tab in the Sidebar so the
    // Pending/Held/Flagged/Confirmed sales tabs don't include them.
    // The Service module still has its dedicated Replacement view via
    // useReplacementOrders().
    const sales = active.filter(o => o.kind !== 'replacement');
    return {
      all:         active,
      pending:     sales.filter(o => o.status === 'pending'),
      held:        sales.filter(o => o.status === 'held'),
      flagged:     sales.filter(o => o.status === 'flagged'),
      approved:    sales.filter(o => o.status === 'approved'),
      replacement: active.filter(o => o.kind === 'replacement'),
      loading,
    };
  }, [cache, fulfilledOrderIds, shippedCustomers, loading]);
}

export function useOrder(id: string | null): { order: Order | null; loading: boolean } {
  const { all, loading } = useOrders();
  const order = id ? all.find(o => o.id === id) ?? null : null;
  return { order, loading: loading && !order };
}

/** All un-shipped replacement orders in 'ready' or 'awaiting' state.
 * Used by ReturnsTab/RefundsTab (#83) to warn when a customer has a queued
 * replacement that should be held before their refund is processed. */
export function useQueuedReplacements(): { replacements: Order[]; loading: boolean } {
  const [replacements, setReplacements] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('kind', 'replacement')
        .in('replacement_state', ['ready', 'awaiting'])
        .is('shipped_at', null)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setReplacements(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:queued_replacements')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' },
          (payload) => {
            setReplacements(prev => {
              const updated = payload.new as Order | undefined;
              const deleted = payload.old as { id: string } | undefined;
              if (payload.eventType === 'DELETE' && deleted) {
                return prev.filter(r => r.id !== deleted.id);
              }
              if (updated) {
                const isQueued =
                  updated.kind === 'replacement' &&
                  (updated.replacement_state === 'ready' || updated.replacement_state === 'awaiting') &&
                  !updated.shipped_at;
                const idx = prev.findIndex(r => r.id === updated.id);
                if (!isQueued) return prev.filter(r => r.id !== updated.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = updated; return next; }
                return [...prev, updated];
              }
              return prev;
            });
          })
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, []);

  return { replacements, loading };
}

/** Mark a queued replacement as held while a refund is in progress. Reversible
 * via resumeReplacement. Does NOT free reserved units — units stay reserved
 * so the replacement can be resumed if the refund is later denied. */
export async function holdReplacement(orderId: string, reason?: string): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ replacement_state: 'held', held_reason: reason ?? null })
    .eq('id', orderId);
  if (error) throw error;
  await logAction('repl_held', orderId, reason ?? 'held pending refund review');
}

/** Resume a previously held replacement, restoring it to 'ready' or 'awaiting'. */
export async function resumeReplacement(orderId: string, state: 'ready' | 'awaiting'): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ replacement_state: state, held_reason: null })
    .eq('id', orderId);
  if (error) throw error;
  await logAction('repl_resumed', orderId, `resumed → ${state}`);
}

export function useOrderNotes(orderId: string | null): {
  notes: OrderNote[];
  loading: boolean;
} {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) { setNotes([]); setLoading(false); return; }

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('order_notes')
        .select('*')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (!error && data) setNotes(data as OrderNote[]);
      setLoading(false);

      channel = supabase
        .channel(`order_notes:${orderId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'order_notes',
            filter: `order_id=eq.${orderId}`,
          },
          (payload) => {
            setNotes(prev => [payload.new as OrderNote, ...prev]);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, [orderId]);

  return { notes, loading };
}

/** Returns the next replacement order ref (R-0001, R-0002, ...). Server-side
 *  RPC to avoid client-side races on the counter. */
export async function nextReplacementOrderRef(): Promise<string> {
  const { data, error } = await supabase.rpc('next_replacement_order_ref');
  if (error) throw new Error(error.message);
  if (typeof data !== 'string' || !data.startsWith('R-')) {
    throw new Error(`Unexpected response from next_replacement_order_ref: ${JSON.stringify(data)}`);
  }
  return data;
}

export type ReplacementLineItem =
  | { kind: 'part'; part_id: string; sku: string; name: string; qty: number; cost_per_unit_usd: number }
  // Out-of-stock part (on_hand = 0 at selection). Same shape as 'part' but does
  // NOT decrement stock — the order is created as 'awaiting'.
  | { kind: 'part_pending'; part_id: string; sku: string; name: string; qty: number; cost_per_unit_usd: number }
  | { kind: 'unit'; unit_serial: string; batch: string; name: string; qty: 1; cost_usd: number }
  // Unit from a batch with no ready stock yet (e.g. P100X in production). No
  // serial assigned; sets awaiting_batch_id; does NOT reserve a unit.
  | { kind: 'unit_pending'; batch: string; name: string; qty: 1; cost_usd: number }
  // Replacement base (backlog #90) — serialized like a full unit but ships only
  // the base body. Batch must start with 'BASE' so the picker can identify it.
  | { kind: 'base'; unit_serial: string; batch: string; name: string; qty: 1; cost_usd: number }
  // Base with no ready serial yet — routes to Manufacturing for a new build.
  | { kind: 'base_pending'; batch: string; name: string; qty: 1; cost_usd: number };

/** True if any line is unfulfillable now (out-of-stock part or pending batch),
 *  which means the order must be created as 'awaiting' rather than 'ready'. */
export function hasPendingLine(items: ReplacementLineItem[]): boolean {
  return items.some(li => li.kind === 'part_pending' || li.kind === 'unit_pending' || li.kind === 'base_pending');
}

export type ReplacementOrderInput = {
  ticket_id: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  address: {
    address_line: string | null;
    city: string;
    region_state: string | null;
    country: 'US' | 'CA';
    postal_code: string | null;
  };
  line_items: ReplacementLineItem[];
};

function computeCogs(items: ReplacementLineItem[]): number {
  return items.reduce((sum, li) => {
    if (li.kind === 'part' || li.kind === 'part_pending') return sum + li.cost_per_unit_usd * li.qty;
    return sum + li.cost_usd; // unit | unit_pending
  }, 0);
}

// Replacement orders are internal/warranty and skip Shopify-style financial
// fields. These defaults make the row valid for the existing Order Review
// flow (which expects non-null totals + currency) without implying any
// customer payment.
const REPLACEMENT_ORDER_DEFAULTS = {
  freight_estimate_usd: 0,
  freight_threshold_usd: 0,
  currency: 'USD',
  total_usd: 0,
  address_verdict: 'house' as const,
  sales_confirmed_fit: false,
};

/** Creates a replacement order (kind='replacement', status='pending'),
 *  back-links the ticket, decrements parts.on_hand, and reserves any units.
 *  Returns the new order_ref + id.
 *
 *  Atomicity caveat: the four writes (order INSERT, ticket UPDATE, parts
 *  decrement, units reserve) are NOT transactional. Partial-failure
 *  recovery, by step:
 *    - INSERT fails: nothing to clean up.
 *    - INSERT ok, ticket UPDATE fails: the order exists but no back-link.
 *      Manually run `update service_tickets set replacement_order_id = ?
 *      where id = ?` or delete the order.
 *    - Ticket UPDATE ok, parts decrement fails partway: some on_hand
 *      values already decremented. The exact set is recoverable from
 *      activity_log entries; reverse with adjustPartStock.
 *    - Parts ok, units reserve fails: same shape — recover by reading
 *      activity_log + manually reverting units.status to 'ready'.
 *  A future migration may wrap all four in a server-side RPC for true
 *  transactional safety. For now (low-volume operator workflow) the
 *  trade-off is acceptable.
 */
export async function createReplacementOrder(input: ReplacementOrderInput):
  Promise<{ id: string; order_ref: string }> {
  if (input.line_items.length === 0) throw new Error('At least one line item required');
  const order_ref = await nextReplacementOrderRef();
  const cogs_usd = computeCogs(input.line_items);

  // 1. Insert the order. Address verdict defaults to 'house' so the address
  //    card still renders; operator can re-run verify if they need to.
  const { data: row, error: insErr } = await supabase
    .from('orders')
    .insert({
      order_ref,
      kind: 'replacement',
      status: 'pending',
      replacement_state: 'ready',
      linked_ticket_id: input.ticket_id,
      cogs_usd,
      customer_name: input.customer_name,
      customer_email: input.customer_email ?? null,
      customer_phone: input.customer_phone ?? null,
      address_line: input.address.address_line,
      city: input.address.city,
      region_state: input.address.region_state,
      country: input.address.country,
      postal_code: input.address.postal_code,
      address_customer_postal: input.address.postal_code,
      ...REPLACEMENT_ORDER_DEFAULTS,
      line_items: input.line_items,
    })
    .select('id, order_ref')
    .single();
  if (insErr || !row) throw new Error(`Create order: ${insErr?.message ?? 'no row'}`);

  // 2. Back-link the ticket and mark it queued_for_replacement so it surfaces
  //    with that status in Support Tickets while the replacement is in flight.
  const { error: tErr } = await supabase
    .from('service_tickets')
    .update({ replacement_order_id: row.id, status: 'queued_for_replacement' })
    .eq('id', input.ticket_id);
  if (tErr) throw new Error(`Link ticket: ${tErr.message}`);

  // 3. Decrement parts.on_hand atomically per line item. The RPC takes a
  //    transaction-level lock on the parts row and floors at 0, so two
  //    concurrent replacement orders can't lose a decrement (see migration
  //    20260604220000_decrement_part_on_hand.sql).
  for (const li of input.line_items) {
    if (li.kind !== 'part') continue;
    const { error: pErr } = await supabase.rpc('decrement_part_on_hand', {
      p_part_id: li.part_id,
      p_qty: li.qty,
    });
    if (pErr) throw new Error(`Decrement part ${li.part_id}: ${pErr.message}`);
  }

  // 4. Reserve units and bases — quarantine excluded: do not pick quarantined units.
  for (const li of input.line_items) {
    if (li.kind !== 'unit' && li.kind !== 'base') continue;
    const { data: unitRow } = await supabase
      .from('units')
      .select('status')
      .eq('serial', li.unit_serial)
      .single();
    if (unitRow?.status === 'quarantine') {
      throw new Error(`Unit ${li.unit_serial} is quarantined and cannot be reserved for a replacement order`);
    }
    const { error: uErr } = await supabase
      .from('units')
      .update({ status: 'reserved', customer_order_ref: row.order_ref, customer_name: input.customer_name })
      .eq('serial', li.unit_serial);
    if (uErr) throw new Error(`Reserve unit ${li.unit_serial}: ${uErr.message}`);
  }

  await logAction(
    'replacement_create',
    row.order_ref,
    `from ticket ${input.ticket_id} · ${input.line_items.length} items · COGS $${cogs_usd.toFixed(2)}`,
  );
  return { id: row.id, order_ref: row.order_ref };
}

/** Creates a PENDING replacement (replacement_state='awaiting') for a cart that
 *  contains at least one out-of-stock part or pending-batch unit. Unlike
 *  createReplacementOrder this does NOT decrement parts or reserve units — the
 *  order is waiting on stock/batch and gets fulfilled (and stock consumed) when
 *  it's promoted to 'ready' later. Sets awaiting_batch_id from the first
 *  pending-batch unit so the Replacement queue groups it (backlog #71). Lands
 *  in Order Review > Replacement > "Awaiting Stock / Batch". */
export async function createPendingReplacement(input: ReplacementOrderInput):
  Promise<{ id: string; order_ref: string }> {
  if (input.line_items.length === 0) throw new Error('At least one line item required');
  const order_ref = await nextReplacementOrderRef();
  const cogs_usd = computeCogs(input.line_items);
  const pendingBatch = input.line_items.find(
    (li): li is Extract<ReplacementLineItem, { kind: 'unit_pending' | 'base_pending' }> =>
      li.kind === 'unit_pending' || li.kind === 'base_pending',
  );

  const { data: row, error: insErr } = await supabase
    .from('orders')
    .insert({
      order_ref,
      kind: 'replacement',
      status: 'pending',
      replacement_state: 'awaiting',
      awaiting_batch_id: pendingBatch?.batch ?? null,
      linked_ticket_id: input.ticket_id,
      cogs_usd,
      customer_name: input.customer_name,
      customer_email: input.customer_email ?? null,
      customer_phone: input.customer_phone ?? null,
      address_line: input.address.address_line,
      city: input.address.city,
      region_state: input.address.region_state,
      country: input.address.country,
      postal_code: input.address.postal_code,
      address_customer_postal: input.address.postal_code,
      ...REPLACEMENT_ORDER_DEFAULTS,
      line_items: input.line_items,
    })
    .select('id, order_ref')
    .single();
  if (insErr || !row) throw new Error(`Create pending replacement: ${insErr?.message ?? 'no row'}`);

  // Back-link + queue the ticket. No stock decrement / unit reservation —
  // the order is awaiting stock/batch and consumes nothing until promoted.
  const { error: tErr } = await supabase
    .from('service_tickets')
    .update({ replacement_order_id: row.id, status: 'queued_for_replacement' })
    .eq('id', input.ticket_id);
  if (tErr) throw new Error(`Link ticket: ${tErr.message}`);

  await logAction(
    'replacement_create',
    row.order_ref,
    `PENDING from ticket ${input.ticket_id} · ${input.line_items.length} items · awaiting ${pendingBatch?.batch ?? 'stock'}`,
  );
  return { id: row.id, order_ref: row.order_ref };
}

/** Live-subscribed list of all replacement orders, newest first. */
export function useReplacementOrders(): { orders: Order[]; loading: boolean } {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('kind', 'replacement')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setOrders(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:replacement:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
          setOrders(prev => {
            const row = (payload.new ?? payload.old) as Order | undefined;
            if (!row || row.kind !== 'replacement') return prev;
            if (payload.eventType === 'DELETE') return prev.filter(o => o.id !== row.id);
            const idx = prev.findIndex(o => o.id === row.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
            return [row, ...prev];
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { orders, loading };
}

/** Records that an order shipped. Sets shipped_at and shipping_cost_usd
 *  (the actual freight/label cost from Freightcom/ClickShip). Works for
 *  both sales and replacements. */
export async function markOrderShipped(orderId: string, shippingCostUsd: number): Promise<void> {
  if (!Number.isFinite(shippingCostUsd) || shippingCostUsd < 0) {
    throw new Error('shipping_cost_usd must be a non-negative number');
  }
  const { data: row, error: rErr } = await supabase
    .from('orders')
    .select('order_ref, customer_email')
    .eq('id', orderId)
    .single();
  if (rErr || !row) throw new Error(`Read order: ${rErr?.message ?? 'not found'}`);

  const { error } = await supabase
    .from('orders')
    .update({ shipped_at: new Date().toISOString(), shipping_cost_usd: shippingCostUsd })
    .eq('id', orderId);
  if (error) throw new Error(error.message);
  await logAction('order_shipped', row.order_ref, `shipping $${shippingCostUsd.toFixed(2)}`,
    undefined,
    { klaviyoEvent: 'Order Shipped', ...((row.customer_email as string | null) ? { klaviyoEmail: row.customer_email as string } : {}) });
}

/** Shipped orders that have not yet been marked delivered.
 *  Live-subscribed; disappears from the list once delivered_at is set. */
export function useShippedOrders(): { orders: Order[]; loading: boolean } {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_ref, kind, customer_name, shipped_at, delivered_at')
        .not('shipped_at', 'is', null)
        .is('delivered_at', null)
        .order('shipped_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setOrders(data as Order[]);
      setLoading(false);

      channel = supabase
        .channel('orders:shipped:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
          setOrders(prev => {
            const row = payload.new as Order | null;
            if (payload.eventType === 'DELETE') {
              const old = payload.old as { id: string } | null;
              return old ? prev.filter(o => o.id !== old.id) : prev;
            }
            if (!row) return prev;
            // Remove row if it now has delivered_at or no shipped_at (it no longer belongs)
            if (!row.shipped_at || row.delivered_at) return prev.filter(o => o.id !== row.id);
            const idx = prev.findIndex(o => o.id === row.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
            return [row, ...prev];
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { orders, loading };
}

/** Records that an order was delivered. For replacement orders, also closes
 *  the linked service ticket. Idempotent — safe to call twice. */
export async function markOrderDelivered(orderId: string): Promise<void> {
  const { data: row, error: rErr } = await supabase
    .from('orders')
    .select('kind, linked_ticket_id, order_ref, delivered_at, shipped_at, customer_email')
    .eq('id', orderId)
    .single();
  if (rErr || !row) throw new Error(`Read order: ${rErr?.message ?? 'not found'}`);
  if (row.delivered_at) return;  // already delivered; honor the JSDoc idempotency claim
  if (!row.shipped_at) {
    throw new Error('Cannot mark delivered: order has not been shipped yet.');
  }

  const deliveredAt = new Date().toISOString();
  const { error: uErr } = await supabase
    .from('orders')
    .update({ delivered_at: deliveredAt })
    .eq('id', orderId);
  if (uErr) throw new Error(uErr.message);
  await logAction('order_delivered', row.order_ref, 'delivery confirmed',
    undefined,
    { klaviyoEvent: 'Order Delivered', ...((row.customer_email as string | null) ? { klaviyoEmail: row.customer_email as string } : {}) });

  if (row.kind === 'replacement' && row.linked_ticket_id) {
    const { error: tErr } = await supabase
      .from('service_tickets')
      .update({ status: 'closed', resolved_at: deliveredAt, closed_at: deliveredAt })
      .eq('id', row.linked_ticket_id);
    if (tErr) throw new Error(`Close ticket: ${tErr.message}`);
    await logAction('ticket_auto_closed', row.linked_ticket_id, `via replacement ${row.order_ref}`);
  }
}
