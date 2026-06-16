import { TICKET_STATUSES, type ServiceTicket, type TicketStatus } from '../../lib/service';

// One customer = one ticket "profile" (backlog: merge tickets per customer).
// Grouping is derived at read time — no ticket is destructively merged, so
// every ticket keeps its own status / messages / SLA. A profile just collects
// the tickets that share a customer_id.
export type CustomerGroup = {
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  unitSerial: string | null;        // first non-null serial across the tickets
  tickets: ServiceTicket[];         // sorted open-first, then most-recent
  total: number;
  openCount: number;
  rollupStatus: TicketStatus;       // most-urgent open status (or latest if all closed)
  lastActivity: string;             // ISO ts — newest activity across the tickets
};

export type GroupedTickets = {
  groups: CustomerGroup[];          // open profiles first, then by recency
  unassigned: ServiceTicket[];      // tickets with no customer_id (sorted by recency)
};

// Urgency order = the canonical status order; lower index = more urgent.
const STATUS_RANK: Record<string, number> = Object.fromEntries(
  TICKET_STATUSES.map((s, i) => [s, i]),
);

function activityTs(t: ServiceTicket): string {
  return t.last_message_at ?? t.created_at;
}

function isOpen(t: ServiceTicket): boolean {
  return t.status !== 'closed';
}

/** Group support tickets by customer. Tickets without a customer_id are
 *  returned separately in `unassigned`. Pure — safe to unit-test. */
export function groupTicketsByCustomer(tickets: ServiceTicket[]): GroupedTickets {
  const byCustomer = new Map<string, ServiceTicket[]>();
  const unassigned: ServiceTicket[] = [];

  for (const t of tickets) {
    if (t.customer_id) {
      const list = byCustomer.get(t.customer_id) ?? [];
      list.push(t);
      byCustomer.set(t.customer_id, list);
    } else {
      unassigned.push(t);
    }
  }

  const groups: CustomerGroup[] = [];
  for (const [customerId, list] of byCustomer) {
    const sorted = [...list].sort((a, b) => {
      // Open tickets first, then newest activity first.
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return activityTs(b).localeCompare(activityTs(a));
    });

    const openTickets = sorted.filter(isOpen);
    const rollupPool = openTickets.length > 0 ? openTickets : sorted;
    const rollupStatus = rollupPool.reduce((best, t) =>
      (STATUS_RANK[t.status] ?? 99) < (STATUS_RANK[best.status] ?? 99) ? t : best,
    rollupPool[0]).status;

    const first = sorted[0];
    groups.push({
      customerId,
      customerName: first.customer_name ?? first.customer_email ?? '(unknown)',
      customerEmail: first.customer_email,
      customerPhone: first.customer_phone,
      unitSerial: sorted.find(t => t.unit_serial)?.unit_serial ?? null,
      tickets: sorted,
      total: sorted.length,
      openCount: openTickets.length,
      rollupStatus,
      lastActivity: sorted.reduce((max, t) =>
        activityTs(t) > max ? activityTs(t) : max, activityTs(sorted[0])),
    });
  }

  groups.sort((a, b) => {
    // Profiles with open tickets first, then most-recent activity first.
    if ((a.openCount > 0) !== (b.openCount > 0)) return a.openCount > 0 ? -1 : 1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  unassigned.sort((a, b) => activityTs(b).localeCompare(activityTs(a)));

  return { groups, unassigned };
}
