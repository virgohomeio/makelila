// markPartsReplacementShipped — "we put the lid in the mail", recorded in one
// click instead of six.
//
// A parts-only replacement has no machine to assign, so the fulfillment queue's
// first step (pick a ready unit off the shelf) is one an operator holding a lid
// cannot take. Until this existed such an order either sat in Fulfillment ›
// Replacements forever or got pushed into the queue and stranded at step 1, and
// the only way to close it out was the linked ticket's Replacement Shipped
// button — which ships every replacement on the case at once, machines
// included.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, rpcMock, state } = vi.hoisted(() => {
  const state: {
    order: any;
    /** What liveReplacementsForTicket sees after this one shipped. */
    siblings: any[];
    ticket: any;
    ordersReads: number;
    updates: Array<{ table: string; patch: any }>;
    upserts: Array<{ table: string; row: any; opts: any }>;
  } = {
    order: null, siblings: [], ticket: null, ordersReads: 0, updates: [], upserts: [],
  };

  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'neq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const fromMock = vi.fn((table: string) => ({
    select: () => {
      if (table === 'orders') {
        state.ordersReads += 1;
        // First read is the order itself; the next is the sibling lookup.
        return state.ordersReads === 1
          ? terminal({ data: state.order, error: null })
          : terminal({ data: state.siblings, error: null });
      }
      return terminal({ data: state.ticket, error: null });
    },
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
    upsert: (row: any, opts: any) => {
      state.upserts.push({ table, row, opts });
      return terminal({ data: null, error: null });
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
const logActionMock = vi.fn(() => Promise.resolve());
vi.mock('./activityLog', () => ({ logAction: (...a: unknown[]) => logActionMock(...(a as [])) }));
vi.mock('./parts', () => ({ adjustPartStock: vi.fn(() => Promise.resolve()) }));

import { markPartsReplacementShipped } from './orders';

const orderPatch = () => state.updates.find(u => u.table === 'orders')?.patch;
const queueUpsert = () => state.upserts.find(u => u.table === 'fulfillment_queue');

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = []; state.upserts = []; state.ordersReads = 0; state.siblings = [];
  state.ticket = { status: 'waiting_on_customer', tags: ['queued_for_replacement'] };
  state.order = {
    id: 'o-1', order_ref: 'R-0062', kind: 'replacement', status: 'pending',
    shipped_at: null, delivered_at: null, awaiting_batch_id: null, linked_ticket_id: 't-9',
    line_items: [{ kind: 'part', part_id: 'P-LID-V36', sku: 'LILA-LID-V36', name: 'Top Lid', qty: 1, cost_per_unit_usd: 24 }],
  };
});

describe('markPartsReplacementShipped', () => {
  it('stamps the order shipped and approves it', async () => {
    const res = await markPartsReplacementShipped('o-1');
    expect(res.order_ref).toBe('R-0062');
    expect(orderPatch()).toMatchObject({ status: 'approved' });
    expect(orderPatch().shipped_at).toBeTruthy();
  });

  // The queue row at step 6 IS the Fulfillment › Queue › SHIPPED list, and the
  // order carries kind='replacement', so the shipment still reads as one.
  it('lands a fulfillment_queue row at step 6, upserted on order_id', async () => {
    await markPartsReplacementShipped('o-1');
    const up = queueUpsert();
    expect(up?.row).toMatchObject({ order_id: 'o-1', step: 6 });
    expect(up?.row.fulfilled_at).toBeTruthy();
    expect(up?.opts).toEqual({ onConflict: 'order_id' });
    // Never a serial: there is no machine in this box, and assigned_serial is
    // FK'd to shelf_slots.
    expect(up?.row).not.toHaveProperty('assigned_serial');
  });

  it('records carrier and tracking when the operator has them', async () => {
    await markPartsReplacementShipped('o-1', { carrier: ' Canada Post ', tracking_num: ' 1234 ' });
    expect(orderPatch()).toMatchObject({ carrier: 'Canada Post', tracking_num: '1234' });
    expect(queueUpsert()?.row).toMatchObject({ carrier: 'Canada Post', tracking_num: '1234' });
  });

  // An omitted column on an upsert that hits an existing row keeps what is
  // already there, so a blank tracking field can't wipe a label printed earlier.
  it('omits carrier and tracking entirely when left blank', async () => {
    await markPartsReplacementShipped('o-1', { carrier: '', tracking_num: '   ' });
    expect(orderPatch()).not.toHaveProperty('tracking_num');
    expect(queueUpsert()?.row).not.toHaveProperty('tracking_num');
  });

  it('moves the ticket off Queued for Replacement and onto Replacement Sent', async () => {
    const res = await markPartsReplacementShipped('o-1');
    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 't-9', p_tag: 'queued_for_replacement',
    });
    expect(rpcMock).toHaveBeenCalledWith('add_ticket_tag', {
      p_ticket_id: 't-9', p_tag: 'replacement_sent',
    });
    expect(res.ticket_marked_sent).toBe(true);
  });

  // A case owed a lid AND a machine is still owed the machine. Saying
  // "Replacement Sent" on it would be the board telling CS the customer is
  // done waiting when they are not.
  it('leaves the ticket queued while another replacement on it is still live', async () => {
    state.siblings = [{ id: 'o-2', order_ref: 'R-0063' }];
    const res = await markPartsReplacementShipped('o-1');
    expect(res.ticket_marked_sent).toBe(false);
    expect(rpcMock).not.toHaveBeenCalledWith('remove_ticket_tag', expect.anything());
    expect(rpcMock).not.toHaveBeenCalledWith('add_ticket_tag', expect.anything());
  });

  it('does not reopen a closed ticket', async () => {
    state.ticket = { status: 'closed', tags: [] };
    const res = await markPartsReplacementShipped('o-1');
    expect(res.ticket_marked_sent).toBe(false);
    // The stale queued chip still goes, though — the box has gone out.
    expect(rpcMock).toHaveBeenCalledWith('remove_ticket_tag', {
      p_ticket_id: 't-9', p_tag: 'queued_for_replacement',
    });
    expect(rpcMock).not.toHaveBeenCalledWith('add_ticket_tag', expect.anything());
  });

  // The whole point of the guard: this path records no serial, so it must never
  // be the way a machine leaves the building.
  it('refuses a replacement that carries a unit', async () => {
    state.order.line_items = [{ kind: 'unit', unit_serial: '00019', batch: 'P150', name: 'LILA', qty: 1, cost_usd: 314 }];
    await expect(markPartsReplacementShipped('o-1')).rejects.toThrow(/whole unit/i);
    expect(state.updates).toEqual([]);
  });

  it('refuses an order with no items recorded', async () => {
    state.order.line_items = [];
    await expect(markPartsReplacementShipped('o-1')).rejects.toThrow(/no items/i);
  });

  it('refuses a cancelled replacement', async () => {
    state.order.status = 'cancelled';
    await expect(markPartsReplacementShipped('o-1')).rejects.toThrow(/cancelled/i);
  });

  it('refuses one that already shipped', async () => {
    state.order.shipped_at = '2026-09-01T00:00:00Z';
    await expect(markPartsReplacementShipped('o-1')).rejects.toThrow(/already shipped/i);
  });

  it('refuses a sale — sales reach shipped through the queue', async () => {
    state.order.kind = 'sale';
    await expect(markPartsReplacementShipped('o-1')).rejects.toThrow(/not a replacement/i);
  });
});
