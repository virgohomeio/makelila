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

// ---------------------------------------------------------------------------
// Parts-vs-batch narrowing for the Replacement queue saved view.
//
// "Queued for replacement" answers *whether* someone is waiting; it does not
// separate the customer waiting on a $24 lid from the one waiting on a whole
// P100X that hasn't landed yet. Those are different jobs — one ships today
// from the shelf, the other blocks until a batch arrives — so the queue needs
// to split on it.
//
// Batches are derived from the orders themselves rather than enumerated here.
// P100X and LILA-Mini are simply what the data currently holds; a batch we
// have never shipped shows up as its own chip the first time a replacement
// order carries it, with no code change.
// ---------------------------------------------------------------------------

/** `batch:<code>` narrows to one batch; the rest are roll-ups. */
export type ReplacementKindFilter = 'all' | 'parts' | 'any_batch' | `batch:${string}`;

export type ReplacementKindOption = {
  key: ReplacementKindFilter;
  label: string;
  count: number;
  /** Drives indentation: 'batch' entries sit under the 'any_batch' roll-up. */
  group: 'all' | 'parts' | 'any_batch' | 'batch';
};

/** Does a ticket's replacement kinds satisfy the chosen filter?
 *
 *  `kinds` comes from `replacementQueueKindsByTicket`, which yields either
 *  batch codes or the single sentinel 'PARTS' — never both, since a unit takes
 *  precedence over parts shipped alongside it. So parts and batch partition
 *  the queue cleanly.
 *
 *  An empty `kinds` means the ticket is queued but its order could not be
 *  resolved. It stays visible under 'All' and is excluded from every specific
 *  bucket — guessing 'parts' would quietly misfile it. */
export function matchesReplacementKind(
  kinds: string[],
  filter: ReplacementKindFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'parts') return kinds.some(k => !isUnitTag(k));
  if (filter === 'any_batch') return kinds.some(isUnitTag);
  return kinds.includes(filter.slice('batch:'.length));
}

/** The chip row for the Replacement queue view: All, Parts, Any batch, then one
 *  entry per batch actually present, alphabetically.
 *
 *  Counts are over the tickets passed in, so the caller decides whether they
 *  reflect the other active filters. Buckets that would render as a dead
 *  zero-count chip are omitted; 'All' is always present so the row never
 *  disappears entirely. */
export function replacementKindOptions(
  tickets: ServiceTicket[],
  kindsByTicket: Map<string, string[]>,
): ReplacementKindOption[] {
  let parts = 0;
  let anyBatch = 0;
  const batches = new Map<string, number>();

  for (const t of tickets) {
    const kinds = kindsByTicket.get(t.id) ?? [];
    const unitTags = kinds.filter(isUnitTag);
    if (unitTags.length > 0) {
      anyBatch++;
      // A single order can carry two batches; count the ticket under each so
      // picking either batch finds it, exactly as the filter would match.
      for (const b of new Set(unitTags)) batches.set(b, (batches.get(b) ?? 0) + 1);
    } else if (kinds.length > 0) {
      parts++;
    }
  }

  const options: ReplacementKindOption[] = [
    { key: 'all', label: 'All', count: tickets.length, group: 'all' },
  ];
  if (parts > 0) options.push({ key: 'parts', label: 'Parts', count: parts, group: 'parts' });
  if (anyBatch > 0) {
    options.push({ key: 'any_batch', label: 'Any batch', count: anyBatch, group: 'any_batch' });
    for (const [batch, count] of [...batches].sort(([a], [b]) => a.localeCompare(b))) {
      options.push({ key: `batch:${batch}`, label: batch, count, group: 'batch' });
    }
  }
  return options;
}
