// "Queued for <what> Replacement" derivation for the Service > Support Tickets
// list. A ticket only says *that* a customer is waiting on a replacement; the
// linked replacement order says *what for*. This module joins the two so each
// customer row reads "Queued for P100X Replacement" / "Queued for PARTS
// Replacement" instead of the generic status pill.
//
// Pure — no supabase import, unit-testable without env.
import type { Order } from '../../lib/orders';
import type { ServiceTicket } from '../../lib/service';
import { replacementQueueKinds, isUnitTag } from '../../lib/replacementTags';

/** True when the ticket is waiting on a replacement — either as its workflow
 *  status or as one of its multi-select status tags. */
export function isQueuedForReplacement(t: ServiceTicket): boolean {
  return t.status === 'queued_for_replacement'
    || (t.tags ?? []).includes('queued_for_replacement');
}

/** ticket id → replacement kinds ("P100X", "PARTS"), for every ticket queued
 *  for a replacement whose order we can resolve. The link is stored on both
 *  sides (`service_tickets.replacement_order_id` and `orders.linked_ticket_id`);
 *  we prefer the ticket's own back-link and fall back to the order's. Tickets
 *  with no resolvable order are omitted, so the caller falls back to the plain
 *  "Queued for Replacement" pill rather than inventing a kind. */
export function replacementQueueKindsByTicket(
  tickets: ServiceTicket[],
  orders: Order[],
): Map<string, string[]> {
  const byOrderId = new Map<string, Order>();
  const byTicketId = new Map<string, Order>();
  for (const o of orders) {
    byOrderId.set(o.id, o);
    if (o.linked_ticket_id) byTicketId.set(o.linked_ticket_id, o);
  }

  const out = new Map<string, string[]>();
  for (const t of tickets) {
    if (!isQueuedForReplacement(t)) continue;
    const order = (t.replacement_order_id ? byOrderId.get(t.replacement_order_id) : undefined)
      ?? byTicketId.get(t.id);
    if (!order) continue;
    const kinds = replacementQueueKinds(order);
    if (kinds.length > 0) out.set(t.id, kinds);
  }
  return out;
}

/** The distinct replacement kinds across a set of tickets (one customer row),
 *  units first so "Queued for P100X Replacement" leads the parts chips. */
export function groupQueueKinds(
  tickets: ServiceTicket[],
  kindsByTicket: Map<string, string[]>,
): string[] {
  const kinds = new Set<string>();
  for (const t of tickets) for (const k of kindsByTicket.get(t.id) ?? []) kinds.add(k);
  return [...kinds].sort((a, b) => {
    const ua = isUnitTag(a) ? 0 : 1;
    const ub = isUnitTag(b) ? 0 : 1;
    return ua - ub || a.localeCompare(b);
  });
}
