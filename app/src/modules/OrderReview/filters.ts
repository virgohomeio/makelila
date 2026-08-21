import type { Order, OrderStatus, AreaType } from '../../lib/orders';
import { canConfirm } from './detail/readiness';
import { daysSincePlaced, OVERDUE_DAYS } from './sla';

/* Every filter the Sales queue offers, as pure functions over a list of
 * orders. Lives outside the components so the queue bar, the saved-view chips
 * and the list all count the same way, and so the counting can be tested
 * without rendering anything. */

export type SavedView = 'blocked' | 'overdue' | 'replacement';
export type ReplacementSub = 'ready' | 'awaiting';

export interface OrderFilters {
  /** 'all' means the live queue — cancelled orders are terminal and stay out
   *  of it, exactly as Support Tickets keeps 'closed' out of its queue bar. */
  status: OrderStatus | 'all';
  savedView: SavedView | null;
  replacementSub: ReplacementSub;
  query: string;
  country: string;          // 'all' | 'CA' | 'US'
  area: AreaType | 'all';
}

export const EMPTY_FILTERS: OrderFilters = {
  status: 'all',
  savedView: null,
  replacementSub: 'ready',
  query: '',
  country: 'all',
  area: 'all',
};

export const isCancelled = (o: Order) => o.status === 'cancelled';

/** Still waiting on a review decision — the orders the SLA is actually about.
 *  An order already confirmed or cancelled cannot be late, and cannot be
 *  blocked. */
export const awaitingDecision = (o: Order) =>
  o.status === 'pending' || o.status === 'held' || o.status === 'flagged';

/** Has unmet confirm criteria. Asks the same question the detail pane's
 *  blocker strip answers. */
export const isBlocked = (o: Order) => awaitingDecision(o) && !canConfirm(o);

export const isOverdue = (o: Order, now: number) =>
  awaitingDecision(o) && daysSincePlaced(o.placed_at ?? o.created_at, now) > OVERDUE_DAYS;

export const isReplacement = (o: Order) => o.kind === 'replacement' && !isCancelled(o);

export const isRiskAddress = (o: Order) =>
  o.address_verdict === 'apt' || o.address_verdict === 'condo' || o.address_verdict === 'remote';

/** Counts for the queue bar and its legend, over the whole pool. */
export function statusCounts(orders: Order[]): Record<OrderStatus, number> {
  const c: Record<OrderStatus, number> = {
    pending: 0, held: 0, flagged: 0, approved: 0, cancelled: 0,
  };
  for (const o of orders) c[o.status]++;
  return c;
}

export function savedViewCounts(orders: Order[], now: number): Record<SavedView, number> {
  return {
    blocked:     orders.filter(isBlocked).length,
    overdue:     orders.filter(o => isOverdue(o, now)).length,
    replacement: orders.filter(isReplacement).length,
  };
}

/** How many filters are narrowing the list right now — drives the "Clear"
 *  button and the toolbar's active badges. */
export function activeFilterCount(f: OrderFilters): number {
  return [
    f.status !== 'all',
    f.savedView !== null,
    f.query.trim() !== '',
    f.country !== 'all',
    f.area !== 'all',
  ].filter(Boolean).length;
}

function matchesQuery(o: Order, q: string): boolean {
  return o.customer_name.toLowerCase().includes(q)
      || o.order_ref.toLowerCase().includes(q)
      || (o.customer_email ?? '').toLowerCase().includes(q)
      || (o.city ?? '').toLowerCase().includes(q);
}

/**
 * Apply every filter, then sort.
 *
 * Live rows are a work queue and read best by order ref. Cancelled is a lookup
 * list that arrives newest-first from bucketOrders, so it is left in the order
 * given — sorting by ref there would bury the one just cancelled.
 */
export function filterOrders(orders: Order[], f: OrderFilters, now: number): Order[] {
  const showingCancelled = f.status === 'cancelled';

  let out = orders.filter(o => (showingCancelled ? isCancelled(o) : !isCancelled(o)));

  if (f.status !== 'all' && f.status !== 'cancelled') {
    out = out.filter(o => o.status === f.status);
  }

  if (f.savedView === 'blocked')     out = out.filter(isBlocked);
  if (f.savedView === 'overdue')     out = out.filter(o => isOverdue(o, now));
  if (f.savedView === 'replacement') {
    out = out.filter(isReplacement).filter(o =>
      f.replacementSub === 'awaiting'
        ? o.replacement_state === 'awaiting'
        : o.replacement_state !== 'awaiting');
  }

  if (f.country !== 'all') out = out.filter(o => o.country === f.country);
  if (f.area !== 'all')    out = out.filter(o => o.area_type === f.area);

  const q = f.query.trim().toLowerCase();
  if (q) out = out.filter(o => matchesQuery(o, q));

  if (showingCancelled) return out;
  return [...out].sort((a, b) => a.order_ref.localeCompare(b.order_ref));
}
