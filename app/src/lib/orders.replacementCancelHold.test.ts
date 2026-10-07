// Cancelling a replacement from the fulfillment queue has to say something to
// the service ticket that asked for it. The customer's case is not finished —
// it just isn't waiting on a box any more — so the ticket moves off
// "Queued for Replacement" and onto "On Hold".
//
// Three things make this narrower than it sounds, and each has a test here:
//   * only the operator-facing cancel does it. Closing a ticket auto-cancels
//     its awaiting replacements through the same helper, and flipping status
//     there would reopen the case the operator just closed.
//   * only if the ticket still holds the marker (status OR tag).
//   * only if no OTHER live replacement remains on the ticket. ST-2026-0489
//     briefly carried two lids five seconds apart from a double-submit;
//     cancelling one of those must not say the customer is waiting on nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, rpcMock, state } = vi.hoisted(() => {
  const state: {
    order: any;
    ticket: any;
    siblings: any[];
    updates: Array<{ table: string; patch: any }>;
  } = { order: null, ticket: null, siblings: [], updates: [] };

  // Every builder method returns the same awaitable. Awaiting the chain gives
  // the list result (the sibling-replacement lookup); .single()/.maybeSingle()
  // give the single-row result. That covers both shapes each table is queried
  // with without the mock needing to parse the filters.
  const terminal = (list: any, one: any): any => {
    const p: any = Promise.resolve({ data: list, error: null });
    for (const m of ['eq', 'neq', 'is', 'in', 'select', 'order'] as const) {
      p[m] = () => terminal(list, one);
    }
    p.single = () => Promise.resolve({ data: one, error: null });
    p.maybeSingle = () => Promise.resolve({ data: one, error: null });
    return p;
  };

  const fromMock = vi.fn((table: string) => ({
    select: () => table === 'orders'
      ? terminal(state.siblings, state.order)
      : terminal(null, state.ticket),
    update: (patch: any) => {
      state.updates.push({ table, patch });
      return terminal(null, null);
    },
    insert: () => terminal(null, null),
    delete: () => terminal([{ id: state.order?.id }], null),
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

import { cancelOrder, cancelPendingReplacementsForTicket } from './orders';

const ticketPatches = () =>
  state.updates.filter(u => u.table === 'service_tickets').map(u => u.patch);

beforeEach(() => {
  state.updates = [];
  state.siblings = [];
  state.order = {
    id: 'o-repl', order_ref: 'R-0067', kind: 'replacement', status: 'approved',
    replacement_state: 'ready', linked_ticket_id: 't-489', line_items: [],
    customer_name: 'Jeff Mottle', customer_email: 'jmottle@lightscape.ca',
    customer_phone: null, total_usd: 0, placed_at: null,
    created_at: '2026-09-02T16:29:44Z', financial_status: null,
  };
  state.ticket = {
    status: 'queued_for_replacement', ticket_number: 'ST-2026-0489', tags: [],
  };
});

describe('cancelling a replacement from the fulfillment queue', () => {
  it('moves the linked ticket to on_hold', async () => {
    await cancelOrder('o-repl', 'Duplicate of R-0068');
    expect(ticketPatches()).toContainEqual({ status: 'on_hold' });
  });

  it('moves it when the marker is a tag rather than the status', async () => {
    state.ticket = {
      status: 'waiting_on_us', ticket_number: 'ST-2026-0489',
      tags: ['queued_for_replacement'],
    };
    await cancelOrder('o-repl', 'Duplicate of R-0068');
    expect(ticketPatches()).toContainEqual({ status: 'on_hold' });
  });

  it('leaves the ticket alone while another live replacement remains on it', async () => {
    state.siblings = [{ id: 'o-repl-2' }];
    await cancelOrder('o-repl', 'Duplicate of R-0068');
    expect(ticketPatches()).not.toContainEqual({ status: 'on_hold' });
    // The back-link still gets cleared — that half is about this order.
    expect(ticketPatches()).toContainEqual({ replacement_order_id: null });
  });

  it('leaves a closed ticket closed', async () => {
    state.ticket = { status: 'closed', ticket_number: 'ST-2026-0489', tags: [] };
    await cancelOrder('o-repl', 'Cleaning up');
    expect(ticketPatches()).not.toContainEqual({ status: 'on_hold' });
  });

  it('leaves a ticket that was never queued for a replacement alone', async () => {
    state.ticket = { status: 'in_progress', ticket_number: 'ST-2026-0489', tags: [] };
    await cancelOrder('o-repl', 'Cleaning up');
    expect(ticketPatches()).not.toContainEqual({ status: 'on_hold' });
  });

  it('still cancels the order when the ticket update fails', async () => {
    // Best-effort by design: the stock is already released and the order is
    // going to be cancelled either way. A ticket that will not move is a
    // smaller problem than a caller left unsure which half happened.
    state.ticket = null;
    await expect(cancelOrder('o-repl', 'Duplicate')).resolves.toBeUndefined();
    const orderPatch = state.updates.find(u => u.table === 'orders')?.patch;
    expect(orderPatch).toMatchObject({ status: 'cancelled' });
  });

  it('does not touch the ticket for a SALE order', async () => {
    state.order = { ...state.order, kind: 'sale', order_ref: '#1179', total_usd: 4999 };
    await cancelOrder('o-repl', 'Customer changed their mind');
    expect(ticketPatches()).toEqual([]);
  });
});

describe('closing a ticket that auto-cancels its awaiting replacements', () => {
  it('does not put the ticket it just closed back on hold', async () => {
    state.order = { ...state.order, replacement_state: 'awaiting', status: 'pending' };
    state.siblings = [state.order];
    await cancelPendingReplacementsForTicket('t-489');
    expect(ticketPatches()).not.toContainEqual({ status: 'on_hold' });
  });
});
