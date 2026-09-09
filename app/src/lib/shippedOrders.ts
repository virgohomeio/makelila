import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { normaliseOrderRef } from './refundedOrders';

/** An order whose machine is already at the customer must not still be sitting
 *  in "Ready to ship".
 *
 *  The fulfillment queue only ever advances by hand: an operator walks a row
 *  from Assign to Email and the sixth step stamps fulfilled_at. Nothing closes
 *  a row out when the shipment happens some other way — booked straight in
 *  Freightcom, shipped off the old spreadsheet, or picked from the shelf by
 *  someone who never opened the queue. Those rows just stay.
 *
 *  Six sale orders were stuck like that on 2026-09-04, all queued 2026-06-05
 *  and all long since delivered — #1178 (Patrick Cusick) sat at step 1 "Assign"
 *  three months after unit LL01-00000000252 was delivered to him. The picker
 *  reads that rail to decide what to pack next, so every one of them was an
 *  invitation to send a second machine.
 *
 *  Two signals say a machine went out for an order, and only two:
 *
 *    'ref'      — a unit is stamped with this order's ref and its status is
 *                 'shipped'. Someone wrote that order number on that machine;
 *                 it is order-level truth and needs no corroboration.
 *    'in-queue' — a shipments row is linked to this order and was booked while
 *                 the queue row was already open. The link itself may be a
 *                 name match (shipments.order_match_method is 'customer_name'
 *                 on 17 rows), which is why the date matters: a shipment
 *                 booked *after* this order was queued cannot be an older one
 *                 of the customer's mis-attributed to it.
 *
 *  Deliberately NOT a signal: the customer having any shipped unit. That is the
 *  heuristic bucketOrders uses in Sales, and it hides 69 pending orders — every
 *  repeat customer's brand-new order included. It is far too blunt to decide
 *  whether a specific box has been packed.
 *
 *  Replacements answer to a third signal instead, and only that one:
 *
 *    'ticket-closed' — the support case behind the replacement is closed. A
 *                      replacement exists to settle one ticket, so a closed
 *                      ticket is an operator saying that case is finished and
 *                      nothing is owed. This is already how the rest of the app
 *                      reads replacements (bucketOrders and useQueuedReplacements
 *                      both filter on it) for the same reason: shipped_at is
 *                      almost never stamped on a replacement, so it cannot be
 *                      the thing that closes one out.
 */

/** units, narrowed to what identifies an order-level shipment. */
export type ShippedUnitRow = {
  serial: string;
  status: string;
  customer_order_ref: string | null;
  shipped_at: string | null;
};

/** shipments, narrowed the same way. */
export type ShipmentRow = {
  order_id: string | null;
  unit_serial: string | null;
  booked_at: string | null;
  delivered_at: string | null;
};

export type ShippedEvidence = {
  units: ShippedUnitRow[];
  shipments: ShipmentRow[];
  /** ids of every service_ticket at status 'closed'. */
  closedTicketIds: Set<string>;
};

export type ShippedMark = {
  basis: 'ref' | 'in-queue' | 'ticket-closed';
  serial: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
};

/** The order fields this needs. `kind` matters — see markShippedForOrder. */
export type ShippableOrder = {
  id: string;
  order_ref: string;
  kind?: 'sale' | 'replacement' | string | null;
  /** Replacements only: the support case this box was raised to settle. */
  linked_ticket_id?: string | null;
};

const EMPTY_EVIDENCE: ShippedEvidence = { units: [], shipments: [], closedTicketIds: new Set() };

/** Did `a` happen at or after `b`? False whenever either timestamp is missing —
 *  an absent date is not evidence, and this guard only ever adds a reason to
 *  treat a row as shipped. */
function atOrAfter(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  return Number.isFinite(at) && Number.isFinite(bt) && at >= bt;
}

/** Evidence that a queue row is no longer owed a box, or null.
 *
 *  `queuedAt` is when the fulfillment_queue row was created; it is what makes
 *  the weaker 'in-queue' signal safe. Pass null to skip that signal entirely.
 *
 *  A replacement is decided on its ticket alone. Its *shipping* data stays
 *  excluded, because it is known bad: R-0027 was raised on 2026-08-19 and
 *  carries a serial-matched shipments row booked 2026-03-12 — five months
 *  earlier — because the June 2026 import matched replacements to whatever the
 *  customer had last received. Reading dates like that would hide live
 *  replacements. The ticket has no such problem: it is a person's own statement
 *  that the case is done, and closing one already auto-cancels the replacements
 *  still awaiting stock behind it (cancelReplacementsForClosedTicket). All this
 *  adds is the rows that had already been queued when that happened, which the
 *  auto-cancel never covered — so they sat in Ready to ship instead.
 *
 *  R-0005, R-0027 and R-0031 were doing exactly that on 2026-09-09: each was
 *  queued in August against a ticket closed on 2026-06-22, months after the
 *  part had been delivered. All three read OVERDUE by ~14d for a latch, a lid
 *  and a chamber the customer already had.
 */
export function markShippedForOrder(
  order: ShippableOrder,
  queuedAt: string | null,
  evidence: ShippedEvidence = EMPTY_EVIDENCE,
): ShippedMark | null {
  if (order.kind === 'replacement') {
    if (order.linked_ticket_id && evidence.closedTicketIds.has(order.linked_ticket_id)) {
      return { basis: 'ticket-closed', serial: null, shippedAt: null, deliveredAt: null };
    }
    return null;
  }

  const ref = normaliseOrderRef(order.order_ref);
  if (ref) {
    const stamped = evidence.units.find(
      u => u.status === 'shipped' && normaliseOrderRef(u.customer_order_ref) === ref,
    );
    if (stamped) {
      return {
        basis: 'ref',
        serial: stamped.serial,
        shippedAt: stamped.shipped_at,
        deliveredAt: null,
      };
    }
  }

  const booked = evidence.shipments.find(
    s => s.order_id === order.id && atOrAfter(s.booked_at, queuedAt),
  );
  if (booked) {
    return {
      basis: 'in-queue',
      serial: booked.unit_serial,
      shippedAt: booked.booked_at,
      deliveredAt: booked.delivered_at,
    };
  }

  return null;
}

/** markShippedForOrder across a queue, keyed by fulfillment_queue row id.
 *  Rows with no evidence are absent rather than mapped to null, so
 *  `marks.has(row.id)` reads as "this one already shipped". */
export function indexShippedQueueRows(
  rows: Array<{ id: string; order_id: string; created_at: string }>,
  orders: Map<string, ShippableOrder>,
  evidence: ShippedEvidence,
): Map<string, ShippedMark> {
  const index = new Map<string, ShippedMark>();
  for (const row of rows) {
    const order = orders.get(row.order_id);
    if (!order) continue;
    const mark = markShippedForOrder(order, row.created_at, evidence);
    if (mark) index.set(row.id, mark);
  }
  return index;
}

/** What the operator reads on the row. A closed case is not the same claim as
 *  a tracked shipment, so it does not borrow that wording. */
export function shippedMarkLabel(mark: ShippedMark): string {
  return mark.basis === 'ticket-closed' ? 'CASE CLOSED' : 'ALREADY SHIPPED';
}

/** The banner heading on the detail pane. */
export function shippedMarkHeading(mark: ShippedMark): string {
  return mark.basis === 'ticket-closed'
    ? 'CASE CLOSED — NOTHING TO SEND'
    : 'ALREADY SHIPPED — DO NOT PACK';
}

export function shippedMarkTitle(mark: ShippedMark): string {
  if (mark.basis === 'ticket-closed') {
    return 'The support case behind this replacement is closed, so nothing is owed. '
      + 'Do not pack one — close this row out or move it back.';
  }
  const machine = mark.serial ? `Unit ${mark.serial}` : 'A machine';
  const when = mark.deliveredAt
    ? ` and was delivered ${mark.deliveredAt.slice(0, 10)}`
    : mark.shippedAt
      ? ` on ${mark.shippedAt.slice(0, 10)}`
      : '';
  const how = mark.basis === 'ref'
    ? 'is stamped with this order number in Stock'
    : 'was booked against this order after it was queued';
  return `${machine} ${how}${when}. Do not pack a second one — move this row back to Sales or close it out.`;
}

/** Every shipped-unit, shipment and closed-ticket row that can close a queue
 *  row out. All three queries are narrow on purpose: the queue asks this on
 *  every load. */
export async function fetchShippedEvidence(): Promise<ShippedEvidence> {
  const [
    { data: units, error: unitsErr },
    { data: shipments, error: shipErr },
    { data: tickets, error: ticketErr },
  ] = await Promise.all([
    supabase
      .from('units')
      .select('serial, status, customer_order_ref, shipped_at')
      .eq('status', 'shipped')
      .not('customer_order_ref', 'is', null),
    supabase
      .from('shipments')
      .select('order_id, unit_serial, booked_at, delivered_at')
      .not('order_id', 'is', null),
    supabase.from('service_tickets').select('id').eq('status', 'closed'),
  ]);
  if (unitsErr) throw new Error(`Could not read shipped units: ${unitsErr.message}`);
  if (shipErr) throw new Error(`Could not read shipments: ${shipErr.message}`);
  if (ticketErr) throw new Error(`Could not read closed tickets: ${ticketErr.message}`);
  return {
    units: (units ?? []) as ShippedUnitRow[],
    shipments: (shipments ?? []) as ShipmentRow[],
    closedTicketIds: new Set((tickets ?? []).map(t => (t as { id: string }).id)),
  };
}

/** Live shipped evidence for the fulfillment queue.
 *
 *  Refetches on change rather than patching the cache: a units row can arrive
 *  as an UPDATE that only sets status, and a hook that only patches what it is
 *  handed goes quietly stale the moment the socket drops.
 */
export function useShippedEvidence(): { evidence: ShippedEvidence; loading: boolean } {
  const [evidence, setEvidence] = useState<ShippedEvidence>(EMPTY_EVIDENCE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unitsChannel: RealtimeChannel | null = null;
    let shipmentsChannel: RealtimeChannel | null = null;
    let ticketsChannel: RealtimeChannel | null = null;
    let cancelled = false;

    const load = async () => {
      try {
        const next = await fetchShippedEvidence();
        if (!cancelled) setEvidence(next);
      } catch (e) {
        // Non-fatal: without this the queue simply shows every row as ready,
        // which is exactly how it behaved before this module existed.
        console.warn('shipped evidence load failed (non-fatal):', (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load().then(() => {
      if (cancelled) return;
      unitsChannel = supabase
        .channel('units:shipped-evidence')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'units' }, () => { void load(); })
        .subscribe();
      shipmentsChannel = supabase
        .channel('shipments:shipped-evidence')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, () => { void load(); })
        .subscribe();
      // Closing a ticket has to take its replacement out of Ready to ship
      // without a reload — and reopening one has to put it back.
      ticketsChannel = supabase
        .channel('service_tickets:shipped-evidence')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_tickets' }, () => { void load(); })
        .subscribe();
    });

    return () => {
      cancelled = true;
      if (unitsChannel) void unitsChannel.unsubscribe();
      if (shipmentsChannel) void shipmentsChannel.unsubscribe();
      if (ticketsChannel) void ticketsChannel.unsubscribe();
    };
  }, []);

  return { evidence, loading };
}
