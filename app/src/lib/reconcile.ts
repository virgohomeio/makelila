/** Reconciling orders that shipped before the app knew about them.
 *
 *  A sales order is only ever marked fulfilled by walking the six-step
 *  fulfillment queue. When a machine goes out ahead of that — the legacy
 *  spreadsheet workflow, a unit handed over at an event, a shipment booked
 *  straight in the carrier portal — there is no way to catch the app up, so the
 *  order sits in `pending` forever while the customer has had it for months.
 *
 *  Where a Freightcom shipment is booked against the order itself, the link is
 *  unambiguous and can be scripted. This file is for the harder set: the
 *  customer has a shipped unit, but nothing ties that unit to this order. One
 *  customer with two orders and one unit is genuinely ambiguous — it is either
 *  a shipment we never recorded or a duplicate order — so the code proposes and
 *  an operator decides.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type ReconcileOutcome = 'shipped' | 'duplicate' | 'open';

export type ReconcileOrderRow = {
  id: string;
  order_ref: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  city: string;
  region_state: string | null;
  country: string;
  total_usd: number;
  currency: string;
  placed_at: string | null;
  created_at: string;
};

export type ReconcileUnitRow = {
  serial: string;
  customer_id: string | null;
  customer_name: string | null;
  shipped_at: string | null;
  customer_order_ref: string | null;
  carrier: string | null;
  tracking_num: string | null;
};

export type Suggestion =
  | { kind: 'shipped'; serial: string; shippedAt: string | null; confidence: 'high' | 'low'; why: string }
  | { kind: 'duplicate'; ofOrderRef: string; why: string }
  | { kind: 'none'; why: string };

/** How long after an order was placed a shipment can land and still read as
 *  obviously that order's. Beyond it the pairing is still the best available,
 *  but it stops being something to accept without looking. */
const CONFIDENT_WINDOW_DAYS = 120;

const DAY_MS = 86_400_000;

function placedOn(o: ReconcileOrderRow): string {
  return o.placed_at ?? o.created_at;
}

function daysBetween(a: string, b: string): number {
  return (new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}

/** Propose an outcome for every one of a single customer's unreconciled orders.
 *
 *  Pairing runs unit-first, not order-first: a unit is claimed by the *latest*
 *  order placed before it shipped. Walking orders instead would hand a January
 *  shipment to a customer's oldest open order from two years earlier purely
 *  because it came first in the list.
 */
export function suggestForCustomer(
  orders: ReconcileOrderRow[],
  units: ReconcileUnitRow[],
): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  const refs = new Set(orders.map(o => o.order_ref));
  const takenOrder = new Map<string, { serial: string; shippedAt: string | null; confidence: 'high' | 'low'; why: string }>();

  // A unit that already names an order is not a guess — take it as given, and
  // drop units that name some *other* order, which are already accounted for.
  const pool: ReconcileUnitRow[] = [];
  for (const u of units) {
    const claim = u.customer_order_ref;
    if (claim && refs.has(claim)) {
      const target = orders.find(o => o.order_ref === claim);
      if (target && !takenOrder.has(target.id)) {
        takenOrder.set(target.id, {
          serial: u.serial,
          shippedAt: u.shipped_at,
          confidence: 'high',
          why: `Unit ${u.serial} already names this order`,
        });
        continue;
      }
    }
    if (claim) continue;
    pool.push(u);
  }

  // Dated units first, oldest to newest; undated ones last, where they can only
  // pick up whatever is left over.
  const sortedUnits = [...pool].sort((a, b) => {
    if (!a.shipped_at) return 1;
    if (!b.shipped_at) return -1;
    return a.shipped_at.localeCompare(b.shipped_at);
  });
  const sortedOrders = [...orders].sort((a, b) => placedOn(a).localeCompare(placedOn(b)));

  for (const u of sortedUnits) {
    const free = sortedOrders.filter(o => !takenOrder.has(o.id));
    if (free.length === 0) break;

    if (!u.shipped_at) {
      const o = free[0];
      takenOrder.set(o.id, {
        serial: u.serial, shippedAt: null, confidence: 'low',
        why: `Unit ${u.serial} has no ship date on file`,
      });
      continue;
    }

    // The latest order placed on or before the ship date; failing that, the
    // order closest to it in either direction.
    const before = free.filter(o => placedOn(o) <= u.shipped_at!);
    const chosen = before.length > 0
      ? before[before.length - 1]
      : free.reduce((best, o) =>
          Math.abs(daysBetween(u.shipped_at!, placedOn(o))) < Math.abs(daysBetween(u.shipped_at!, placedOn(best)))
            ? o : best);

    const gap = daysBetween(u.shipped_at, placedOn(chosen));
    const confident = gap >= 0 && gap <= CONFIDENT_WINDOW_DAYS;
    takenOrder.set(chosen.id, {
      serial: u.serial,
      shippedAt: u.shipped_at,
      confidence: confident ? 'high' : 'low',
      why: gap >= 0
        ? `Unit ${u.serial} shipped ${Math.round(gap)} day${Math.round(gap) === 1 ? '' : 's'} after this order`
        : `Unit ${u.serial} shipped ${Math.round(-gap)} days *before* this order was placed`,
    });
  }

  for (const o of orders) {
    const hit = takenOrder.get(o.id);
    if (hit) {
      out.set(o.id, { kind: 'shipped', ...hit });
      continue;
    }
    // No unit left for this order. If a sibling order took one, this is very
    // likely the same purchase entered twice — point at the nearest sibling.
    const siblings = orders.filter(s => s.id !== o.id && takenOrder.has(s.id));
    if (siblings.length > 0) {
      const nearest = siblings.reduce((best, s) =>
        Math.abs(daysBetween(placedOn(s), placedOn(o))) < Math.abs(daysBetween(placedOn(best), placedOn(o)))
          ? s : best);
      out.set(o.id, {
        kind: 'duplicate',
        ofOrderRef: nearest.order_ref,
        why: `Every unit this customer has is accounted for by ${nearest.order_ref}`,
      });
      continue;
    }
    out.set(o.id, {
      kind: 'none',
      why: 'No unclaimed shipped unit for this customer',
    });
  }

  return out;
}

// ── The queue ───────────────────────────────────────────────────────────────

export type ReconcileItem = {
  order: ReconcileOrderRow;
  suggestion: Suggestion;
  /** Every unit this customer could plausibly be holding, for the override
   *  picker. Includes units the matcher handed to a sibling order. */
  candidates: ReconcileUnitRow[];
};

export type ReconcileGroup = {
  key: string;
  customerName: string;
  items: ReconcileItem[];
  units: ReconcileUnitRow[];
};

/** Group orders and units by customer. `customer_id` is the real key; the name
 *  is the fallback for rows the auto-customer trigger never resolved. */
function groupKey(customerId: string | null, name: string | null): string {
  return customerId ?? `name:${(name ?? '').toLowerCase().trim()}`;
}

/** Pending sales orders whose customer has a shipped unit, with no shipment
 *  booked against the order itself and no verdict recorded yet.
 *
 *  Deliberately not built on `useOrders`: that hook hides exactly these rows
 *  (any order whose customer name matches a shipped unit's), which is what kept
 *  the backlog invisible in the first place.
 */
export function useReconcileQueue(): {
  groups: ReconcileGroup[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [groups, setGroups] = useState<ReconcileGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Nothing is set before the first await: a synchronous setState inside the
    // effect below would cascade a second render on every mount.
    const [ordersRes, unitsRes, shipmentsRes] = await Promise.all([
      supabase.from('orders').select('*').eq('status', 'pending').eq('kind', 'sale'),
      supabase
        .from('units')
        .select('serial, customer_id, customer_name, shipped_at, customer_order_ref, carrier, tracking_num')
        .eq('status', 'shipped'),
      supabase.from('shipments').select('order_id'),
    ]);

    const firstError = ordersRes.error ?? unitsRes.error ?? shipmentsRes.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    setError(null);

    const withShipment = new Set(
      ((shipmentsRes.data ?? []) as { order_id: string | null }[])
        .map(s => s.order_id).filter((id): id is string => !!id),
    );
    const units = (unitsRes.data ?? []) as ReconcileUnitRow[];
    const orders = ((ordersRes.data ?? []) as (ReconcileOrderRow & { reconcile_outcome?: string | null })[])
      .filter(o => !o.reconcile_outcome)
      .filter(o => !withShipment.has(o.id));

    const unitsByCustomer = new Map<string, ReconcileUnitRow[]>();
    for (const u of units) {
      const k = groupKey(u.customer_id, u.customer_name);
      const list = unitsByCustomer.get(k) ?? [];
      list.push(u);
      unitsByCustomer.set(k, list);
    }

    const ordersByCustomer = new Map<string, ReconcileOrderRow[]>();
    for (const o of orders) {
      const k = groupKey(o.customer_id, o.customer_name);
      // Cohort scope: the customer must actually have a shipped unit. Orders
      // with no shipment and no unit anywhere are a different problem (someone
      // paid and got nothing) and must not be quietly closed from here.
      if (!unitsByCustomer.has(k)) continue;
      const list = ordersByCustomer.get(k) ?? [];
      list.push(o);
      ordersByCustomer.set(k, list);
    }

    const next: ReconcileGroup[] = [];
    for (const [k, custOrders] of ordersByCustomer) {
      const custUnits = unitsByCustomer.get(k) ?? [];
      const suggestions = suggestForCustomer(custOrders, custUnits);
      next.push({
        key: k,
        customerName: custOrders[0].customer_name,
        units: custUnits,
        items: [...custOrders]
          .sort((a, b) => placedOn(a).localeCompare(placedOn(b)))
          .map(o => ({
            order: o,
            suggestion: suggestions.get(o.id) ?? { kind: 'none', why: 'No suggestion' },
            candidates: custUnits,
          })),
      });
    }
    next.sort((a, b) => a.customerName.localeCompare(b.customerName));

    setGroups(next);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);


  return { groups, loading, error, refetch: load };
}

// ── Verdicts ────────────────────────────────────────────────────────────────

async function currentUser(): Promise<{ id: string; email: string }> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('reconcile: not authenticated');
  return { id: data.user.id, email: data.user.email ?? data.user.id };
}

/** Record that this order shipped, outside the queue, as `serial`.
 *
 *  Approving the order makes the auto_enqueue_on_approve trigger create its
 *  queue row; this then fast-forwards that row to step 6 carrying the unit's
 *  own timestamps. Three things about that are load-bearing:
 *
 *  1. `label_confirmed_at` must be set. The fq_sync_unit trigger writes
 *     units.shipped_at = coalesce(label_confirmed_at, fulfilled_at, now()), so
 *     leaving both null would stamp today over the real ship date and move the
 *     warranty expiry with it.
 *  2. `email_sent_at` stays null. Step 5 is what emails the customer, and these
 *     customers received the machine months ago.
 *  3. No welcome email fires either: units_create_lifecycle_on_ship only runs
 *     when a unit's status *changes* to shipped, and these are already shipped.
 */
export async function recordShippedOffline(
  order: ReconcileOrderRow,
  serial: string,
  note?: string,
): Promise<void> {
  const { id: userId, email } = await currentUser();

  const { data: unit, error: uErr } = await supabase
    .from('units')
    .select('serial, shipped_at, carrier, tracking_num')
    .eq('serial', serial)
    .single();
  if (uErr || !unit) throw new Error(`Unit ${serial} not found: ${uErr?.message ?? 'no row'}`);

  const shippedAt = (unit as { shipped_at: string | null }).shipped_at
    ?? order.placed_at ?? order.created_at;
  const nowIso = new Date().toISOString();

  const { error: oErr } = await supabase
    .from('orders')
    .update({
      status: 'approved',
      shipped_at: shippedAt,
      dispositioned_by: userId,
      dispositioned_at: nowIso,
      reconciled_at: nowIso,
      reconciled_by: email,
      reconcile_outcome: 'shipped',
      reconcile_note: note ?? `Shipped outside the queue as ${serial}`,
    })
    .eq('id', order.id);
  if (oErr) throw new Error(`Failed to record the shipment: ${oErr.message}`);

  const { data: queueRow, error: qErr } = await supabase
    .from('fulfillment_queue')
    .select('id')
    .eq('order_id', order.id)
    .maybeSingle();
  if (qErr) throw new Error(`Order was approved but its queue row could not be read: ${qErr.message}`);
  if (!queueRow) throw new Error('Order was approved but no queue row was created.');

  const { error: fErr } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 6,
      assigned_serial: serial,
      carrier: (unit as { carrier: string | null }).carrier,
      tracking_num: (unit as { tracking_num: string | null }).tracking_num,
      label_confirmed_at: shippedAt,
      label_confirmed_by: userId,
      fulfilled_at: shippedAt,
      fulfilled_by: userId,
      reconciled_at: nowIso,
      reconciliation_source: 'sales_reconcile',
    })
    .eq('id', (queueRow as { id: string }).id);
  if (fErr) throw new Error(`Order was approved but the queue row could not be closed: ${fErr.message}`);

  await logAction('order_reconciled_shipped', order.order_ref, `${serial} · shipped ${shippedAt.slice(0, 10)}`,
    { entityType: 'order', entityId: order.id, unitSerial: serial });
}

/** Close this order as a duplicate of one that did ship.
 *
 *  Cancels the order without writing an `order_cancellations` record — unlike
 *  cancelOrder(). Nobody cancelled anything: this is one purchase that was
 *  entered twice, and a cancellation record would put a phantom case in front
 *  of the refund team.
 */
export async function recordDuplicate(
  order: ReconcileOrderRow,
  ofOrderRef: string,
): Promise<void> {
  const { id: userId, email } = await currentUser();
  const nowIso = new Date().toISOString();
  const reason = `Duplicate of ${ofOrderRef} — the unit shipped on that order`;

  const { error } = await supabase
    .from('orders')
    .update({
      status: 'cancelled',
      cancelled_at: nowIso,
      cancelled_reason: reason,
      dispositioned_by: userId,
      dispositioned_at: nowIso,
      reconciled_at: nowIso,
      reconciled_by: email,
      reconcile_outcome: 'duplicate',
      reconcile_note: reason,
    })
    .eq('id', order.id);
  if (error) throw new Error(`Failed to close the duplicate: ${error.message}`);

  await logAction('order_reconciled_duplicate', order.order_ref, reason,
    { entityType: 'order', entityId: order.id });
}

/** Leave the order pending — and put it back in front of Sales.
 *
 *  Without the verdict it stays hidden: bucketOrders drops any order whose
 *  customer name matches a shipped unit's, which is what buried these. The
 *  'open' outcome is the override that beats that heuristic. */
export async function recordStillOpen(order: ReconcileOrderRow, note?: string): Promise<void> {
  const { email } = await currentUser();
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from('orders')
    .update({
      reconciled_at: nowIso,
      reconciled_by: email,
      reconcile_outcome: 'open',
      reconcile_note: note ?? 'Reviewed — nothing shipped against this order yet',
    })
    .eq('id', order.id);
  if (error) throw new Error(`Failed to reopen the order: ${error.message}`);

  await logAction('order_reconciled_open', order.order_ref, 'Left open — returned to Sales',
    { entityType: 'order', entityId: order.id });
}
