// "Replacement Cancelled" on the ticket panel.
//
// The two existing paths each refuse the case that actually strands orders:
// cancelPendingReplacementsForTicket only ever touches 'awaiting' rows, and
// cancelReplacementOrder refuses while the linked ticket is open. Lily Xu's
// R-0048 fell between them — refunded, ticket ST-2026-0406 already closed, the
// order still queued in Fulfillment › Replacements with no way to clear it.
//
// This helper takes every live replacement on the ticket, in either state, with
// no gate on the ticket's status, releases what it holds and deletes it. The
// fulfillment_queue FK cascades on that delete, which is what makes the order
// leave the Queue at the same moment it leaves Sales.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, rpcMock, state } = vi.hoisted(() => {
  const state: {
    linked: any[];
    ticket: any;
    siblings: any[];
    updates: Array<{ table: string; patch: any }>;
    deletes: string[];
    ordersReads: number;
  } = { linked: [], ticket: null, siblings: [], updates: [], deletes: [], ordersReads: 0 };

  const terminal = (list: any, one: any, onDelete?: () => void): any => {
    const p: any = Promise.resolve({ data: list, error: null });
    for (const m of ['eq', 'neq', 'is', 'in', 'select', 'order'] as const) {
      p[m] = () => terminal(list, one, onDelete);
    }
    p.single = () => Promise.resolve({ data: one, error: null });
    p.maybeSingle = () => Promise.resolve({ data: one, error: null });
    return p;
  };

  const fromMock = vi.fn((table: string) => ({
    select: () => {
      if (table !== 'orders') return terminal(null, state.ticket);
      // First orders read is the linked-replacement lookup; every later one is
      // the sibling check inside holdTicketAfterCancel.
      state.ordersReads += 1;
      return terminal(state.ordersReads === 1 ? state.linked : state.siblings, null);
    },
    update: (patch: any) => {
      state.updates.push({ table, patch });
      return terminal(null, null);
    },
    insert: () => terminal(null, null),
    delete: () => {
      const row = state.linked[state.deletes.length];
      state.deletes.push(row?.id);
      return terminal([{ id: row?.id }], null);
    },
  }));

  const rpcMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return { fromMock, rpcMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    rpc: rpcMock,
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { cancelReplacementsForTicket } from './orders';

const ticketPatches = () =>
  state.updates.filter(u => u.table === 'service_tickets').map(u => u.patch);

beforeEach(() => {
  state.updates = [];
  state.deletes = [];
  state.siblings = [];
  state.ordersReads = 0;
  state.linked = [{
    id: 'o-48', order_ref: 'R-0048', replacement_state: 'awaiting',
    linked_ticket_id: 't-406', line_items: [],
  }];
  state.ticket = { status: 'closed', ticket_number: 'ST-2026-0406', tags: [] };
});

describe('cancelReplacementsForTicket', () => {
  it('deletes the replacement even though the ticket is already closed', async () => {
    const refs = await cancelReplacementsForTicket('t-406');
    expect(refs).toEqual(['R-0048']);
    expect(state.deletes).toEqual(['o-48']);
  });

  it('unlinks the order from the ticket and drops the queued tag', async () => {
    await cancelReplacementsForTicket('t-406');
    expect(ticketPatches()).toContainEqual({ replacement_order_id: null });
    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 't-406', p_tag: 'queued_for_replacement',
    });
  });

  it('releases a reserved unit back to ready', async () => {
    state.linked[0].replacement_state = 'ready';
    await cancelReplacementsForTicket('t-406');
    expect(state.updates.filter(u => u.table === 'units').map(u => u.patch))
      .toContainEqual({ status: 'ready', customer_order_ref: null, customer_name: null });
  });

  it('moves a still-open queued ticket to On Hold', async () => {
    state.ticket = { status: 'queued_for_replacement', ticket_number: 'ST-2026-0406', tags: [] };
    await cancelReplacementsForTicket('t-406');
    expect(ticketPatches()).toContainEqual({ status: 'on_hold' });
  });

  it('leaves a closed ticket closed', async () => {
    await cancelReplacementsForTicket('t-406');
    expect(ticketPatches()).not.toContainEqual({ status: 'on_hold' });
  });

  it('cancels every live replacement, not just the awaiting ones', async () => {
    state.linked = [
      { id: 'o-a', order_ref: 'R-0048', replacement_state: 'awaiting', linked_ticket_id: 't-406', line_items: [] },
      { id: 'o-b', order_ref: 'R-0049', replacement_state: 'ready', linked_ticket_id: 't-406', line_items: [] },
    ];
    const refs = await cancelReplacementsForTicket('t-406');
    expect(refs).toEqual(['R-0048', 'R-0049']);
    expect(state.deletes).toEqual(['o-a', 'o-b']);
  });

  it('returns an empty list when the ticket has nothing live', async () => {
    state.linked = [];
    expect(await cancelReplacementsForTicket('t-406')).toEqual([]);
    expect(state.deletes).toEqual([]);
  });
});
