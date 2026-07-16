import { describe, it, expect } from 'vitest';
import { groupTicketsByCustomer } from '../ticketGrouping';
import type { ServiceTicket } from '../../../lib/service';

// The grouping helper only reads a handful of fields; cast a partial fixture
// rather than spelling out all ~55 ServiceTicket columns.
function mk(p: Partial<ServiceTicket> & { id: string }): ServiceTicket {
  return {
    status: 'waiting_on_us',
    customer_id: null,
    customer_name: null,
    customer_email: null,
    customer_phone: null,
    unit_serial: null,
    created_at: '2026-06-01T00:00:00Z',
    last_message_at: null,
    ...p,
  } as ServiceTicket;
}

describe('groupTicketsByCustomer', () => {
  it('groups tickets that share a customer_id', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1', customer_name: 'Joe' }),
      mk({ id: 't2', customer_id: 'c1', customer_name: 'Joe' }),
      mk({ id: 't3', customer_id: 'c2', customer_name: 'Ana' }),
    ]);
    expect(groups).toHaveLength(2);
    const joe = groups.find(g => g.customerId === 'c1')!;
    expect(joe.total).toBe(2);
    expect(joe.customerName).toBe('Joe');
  });

  it('separates tickets with no customer into unassigned', () => {
    const { groups, unassigned } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1' }),
      mk({ id: 't2', customer_id: null }),
      mk({ id: 't3', customer_id: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(unassigned.map(t => t.id).sort()).toEqual(['t2', 't3']);
  });

  it('counts open tickets and rolls up the most recently created ticket status', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1', status: 'waiting_on_us', created_at: '2026-06-01T00:00:00Z' }),
      mk({ id: 't2', customer_id: 'c1', status: 'waiting_on_customer', created_at: '2026-06-05T00:00:00Z' }),
      mk({ id: 't3', customer_id: 'c1', status: 'closed', created_at: '2026-06-03T00:00:00Z' }),
    ]);
    const g = groups[0];
    expect(g.openCount).toBe(2);
    expect(g.rollupStatus).toBe('waiting_on_customer'); // status of the newest-created ticket (t2)
  });

  it('does NOT roll up to closed when an older ticket is still open', () => {
    // A newer closed ticket must not mask an open one — the profile should
    // read as open, never "Complete" (regression: Patrick Taylor).
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1', status: 'waiting_on_us', created_at: '2026-06-01T00:00:00Z' }),
      mk({ id: 't2', customer_id: 'c1', status: 'closed', created_at: '2026-06-09T00:00:00Z' }),
    ]);
    expect(groups[0].openCount).toBe(1);
    expect(groups[0].rollupStatus).toBe('waiting_on_us'); // the open ticket, not the newer closed one
  });

  it('rolls up to the newest OPEN ticket among several open + a newer closed one', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 'onboard',  customer_id: 'c1', status: 'waiting_on_us',           created_at: '2026-05-21T00:00:00Z' }),
      mk({ id: 'support',  customer_id: 'c1', status: 'waiting_on_us',           created_at: '2026-05-22T00:00:00Z' }),
      mk({ id: 'repl',     customer_id: 'c1', status: 'queued_for_replacement',  created_at: '2026-06-11T00:00:00Z' }),
      mk({ id: 'jumper',   customer_id: 'c1', status: 'closed',                  created_at: '2026-07-07T00:00:00Z' }),
    ]);
    expect(groups[0].openCount).toBe(3);
    expect(groups[0].rollupStatus).toBe('queued_for_replacement'); // newest open, not the closed jumper
  });

  it('rolls up to closed only when every ticket is closed', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1', status: 'closed', created_at: '2026-06-01T00:00:00Z' }),
      mk({ id: 't2', customer_id: 'c1', status: 'closed', created_at: '2026-06-09T00:00:00Z' }),
    ]);
    expect(groups[0].openCount).toBe(0);
    expect(groups[0].rollupStatus).toBe('closed');
  });

  it('sorts open profiles before all-closed profiles', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'closedCo', status: 'closed', last_message_at: '2026-06-10T00:00:00Z' }),
      mk({ id: 't2', customer_id: 'openCo', status: 'waiting_on_us', last_message_at: '2026-06-02T00:00:00Z' }),
    ]);
    expect(groups[0].customerId).toBe('openCo'); // open beats more-recent-but-closed
  });

  it('orders tickets within a profile open-first then newest', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 'old-open', customer_id: 'c1', status: 'waiting_on_us', last_message_at: '2026-06-01T00:00:00Z' }),
      mk({ id: 'new-closed', customer_id: 'c1', status: 'closed', last_message_at: '2026-06-09T00:00:00Z' }),
      mk({ id: 'new-open', customer_id: 'c1', status: 'in_progress', last_message_at: '2026-06-08T00:00:00Z' }),
    ]);
    expect(groups[0].tickets.map(t => t.id)).toEqual(['new-open', 'old-open', 'new-closed']);
  });

  it('surfaces the first available unit serial for the profile', () => {
    const { groups } = groupTicketsByCustomer([
      mk({ id: 't1', customer_id: 'c1', status: 'closed', unit_serial: null }),
      mk({ id: 't2', customer_id: 'c1', status: 'waiting_on_us', unit_serial: 'LL01-00000000042' }),
    ]);
    expect(groups[0].unitSerial).toBe('LL01-00000000042');
  });
});
