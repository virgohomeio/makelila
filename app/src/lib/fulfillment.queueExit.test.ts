// The two ways an order leaves the fulfillment queue without shipping, from
// the queue header beside the Due pill:
//   cancelOrderFromQueue     — the order is dead
//   returnQueueRowToOrders   — the shipment isn't ready; the order goes back to
//                              Sales › Orders
// Both must (a) actually drop the queue row, (b) put the reserved unit back on
// the shelf, and (c) leave the order in a state that Order Review can act on.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    queue: any; order: any; unit: any; part: any;
    deletes: string[]; updates: Array<{ table: string; patch: any }>;
    inserts: Array<{ table: string; row: any }>;
  } = {
    queue: null, order: null, unit: null, part: null,
    deletes: [], updates: [], inserts: [],
  };

  // Every PostgREST builder method returns the same awaitable, so a chain of
  // any shape (.eq().eq(), .delete().eq().select(), .select().eq().single())
  // resolves to the row this table was seeded with.
  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'is', 'in', 'select', 'order'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const rowFor = (table: string) =>
    table === 'fulfillment_queue' ? state.queue
    : table === 'orders'         ? state.order
    : table === 'units'          ? state.unit
    : table === 'parts'          ? state.part
    : null;

  const fromMock = vi.fn((table: string) => ({
    select: () => terminal({ data: rowFor(table), error: null }),
    delete: () => { state.deletes.push(table); return terminal({ data: [{ id: 'q-1' }], error: null }); },
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
    insert: (row: any) => { state.inserts.push({ table, row }); return terminal({ data: null, error: null }); },
  }));

  return { fromMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

import { cancelOrderFromQueue, returnQueueRowToOrders } from './fulfillment';
import { bucketOrders, type Order } from './orders';

const patchFor = (table: string) => state.updates.find(u => u.table === table)?.patch;

beforeEach(() => {
  state.deletes = []; state.updates = []; state.inserts = [];
  state.queue = { id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: '00019', fulfilled_at: null };
  state.order = {
    id: 'o-1', order_ref: '#1179', kind: 'sale', status: 'approved',
    replacement_state: null, linked_ticket_id: null, line_items: [],
    customer_name: 'Amy Gaw', customer_email: 'amy@example.com', customer_phone: null,
    total_usd: 4999, placed_at: '2026-06-05T00:00:00Z', created_at: '2026-06-05T00:00:00Z',
  };
  state.unit = { status: 'reserved' };
  state.part = { on_hand: 5 };
});

describe('cancelOrderFromQueue', () => {
  it('drops the queue row, frees the unit, cancels the order and files a cancellation', async () => {
    await cancelOrderFromQueue('q-1', 'Customer changed their mind');

    expect(state.deletes).toContain('fulfillment_queue');
    // Reserved unit goes back to ready stock and its shelf slot frees up.
    expect(patchFor('units')).toMatchObject({ status: 'ready', customer_order_ref: null });
    expect(patchFor('shelf_slots')).toMatchObject({ status: 'available' });

    expect(patchFor('orders')).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'Customer changed their mind',
      dispositioned_by: 'user-1',
    });
    expect(patchFor('orders').cancelled_at).toEqual(expect.any(String));

    const cancellation = state.inserts.find(i => i.table === 'order_cancellations');
    expect(cancellation?.row).toMatchObject({
      order_ref: '#1179',
      customer_name: 'Amy Gaw',
      reason: 'Customer changed their mind',
    });
  });

  it('requires a reason, and writes nothing without one', async () => {
    await expect(cancelOrderFromQueue('q-1', '   ')).rejects.toThrow(/reason is required/i);
    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('refuses an order that has already shipped', async () => {
    state.queue = { ...state.queue, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' };
    await expect(cancelOrderFromQueue('q-1', 'too late')).rejects.toThrow(/already shipped/i);
    expect(state.deletes).toEqual([]);
  });

  // The two cancel paths (queue header and the Sales action bar) have to land
  // in the same place. They meet at orders.status, so feed the patch this write
  // produces straight into the tab router and check where it comes out.
  it('lands the order in Order Review › Cancelled, same as cancelling from Sales', async () => {
    await cancelOrderFromQueue('q-1', 'Customer changed their mind');
    const cancelledOrder = { ...state.order, ...patchFor('orders') } as unknown as Order;

    const buckets = bucketOrders([cancelledOrder], new Set(), new Set());
    expect(buckets.cancelled.map(o => o.order_ref)).toEqual(['#1179']);
    expect(buckets.all).toEqual([]);
    expect(buckets.approved).toEqual([]);
  });

  // Shopify has already given this customer their money back, so there is no
  // refund left to work. Filing the cancellation as a live request puts a card
  // in front of the refund team for a payment that already happened — what
  // re-populated Cancellation Requests when seven settled orders were cleared
  // out of the queue on 2026-08-21.
  it('files an already-refunded order as settled, not as a live refund request', async () => {
    state.order = { ...state.order, financial_status: 'refunded' };
    await cancelOrderFromQueue('q-1', 'refunded');

    const row = state.inserts.find(i => i.table === 'order_cancellations')?.row;
    expect(row).toMatchObject({ status: 'completed' });
    expect(row.refund_approval_id ?? null).toBeNull();
    expect(row.processed_at).toEqual(expect.any(String));
    expect(row.ops_notes).toMatch(/already refunded/i);
  });

  // An authorization that was never captured is the same story: no money moved,
  // so nothing is owed back.
  it('files a voided order as settled too', async () => {
    state.order = { ...state.order, financial_status: 'voided' };
    await cancelOrderFromQueue('q-1', 'never charged');
    expect(state.inserts.find(i => i.table === 'order_cancellations')?.row)
      .toMatchObject({ status: 'completed' });
  });

  // The other half of the rule: money the customer actually paid is a refund
  // the team owes, and that still has to reach the board.
  it.each(['paid', 'partially_refunded', null])(
    'still queues a %s order — that refund is genuinely owed', async (fin) => {
      state.order = { ...state.order, financial_status: fin };
      await cancelOrderFromQueue('q-1', 'Customer changed their mind');

      const row = state.inserts.find(i => i.table === 'order_cancellations')?.row;
      expect(row).toMatchObject({ status: 'submitted' });
      expect(row.processed_at ?? null).toBeNull();
    });

  it('does not file a cancellation for a replacement — nothing was paid for it', async () => {
    state.order = { ...state.order, kind: 'replacement', order_ref: 'R-0002', replacement_state: 'ready' };
    await cancelOrderFromQueue('q-1', 'customer no longer needs it');
    expect(patchFor('orders')).toMatchObject({ status: 'cancelled' });
    expect(state.inserts.find(i => i.table === 'order_cancellations')).toBeUndefined();
  });
});

describe('returnQueueRowToOrders', () => {
  it('drops the queue row, frees the unit and puts a sale back in Pending', async () => {
    const landing = await returnQueueRowToOrders('q-1', 'waiting on a part');

    expect(state.deletes).toContain('fulfillment_queue');
    expect(patchFor('units')).toMatchObject({ status: 'ready' });
    expect(patchFor('orders')).toEqual({ status: 'pending' });
    expect(landing).toMatchObject({ status: 'pending', label: 'Order Review › Pending' });
  });

  it('sends a replacement back to Replacement › Ready when its unit is still on the shelf', async () => {
    state.order = {
      ...state.order, kind: 'replacement', order_ref: 'R-0002',
      line_items: [{ kind: 'unit', unit_serial: '00019', batch: 'P150', qty: 1 }],
    };
    const landing = await returnQueueRowToOrders('q-1');

    expect(patchFor('orders')).toMatchObject({
      status: 'pending', replacement_state: 'ready', awaiting_batch_id: null,
    });
    expect(landing.label).toBe('Order Review › Replacement › Ready');
  });

  it('sends a replacement to Awaiting Stock / Batch when its unit is gone, tagged with the batch', async () => {
    state.order = {
      ...state.order, kind: 'replacement', order_ref: 'R-0002',
      line_items: [{ kind: 'unit', unit_serial: '00019', batch: 'P100X', qty: 1 }],
    };
    // Unit was scrapped while the order sat in the queue → not pickable, and
    // not 'reserved' either, so nothing is released.
    state.unit = { status: 'scrap' };

    const landing = await returnQueueRowToOrders('q-1');

    expect(patchFor('orders')).toMatchObject({
      status: 'pending', replacement_state: 'awaiting', awaiting_batch_id: 'P100X',
    });
    expect(landing.label).toBe('Order Review › Replacement › Awaiting Stock / Batch');
  });

  it('sends a replacement to Awaiting Stock / Batch when a part has run out', async () => {
    state.order = {
      ...state.order, kind: 'replacement', order_ref: 'R-0002',
      line_items: [{ kind: 'part', part_id: 'p-filter', sku: 'LILA-FILTER', qty: 2 }],
    };
    state.part = { on_hand: 1 };

    const landing = await returnQueueRowToOrders('q-1');
    expect(patchFor('orders')).toMatchObject({ replacement_state: 'awaiting', awaiting_batch_id: null });
    expect(landing.label).toBe('Order Review › Replacement › Awaiting Stock / Batch');
  });

  it('refuses an order that has already shipped', async () => {
    state.queue = { ...state.queue, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' };
    await expect(returnQueueRowToOrders('q-1')).rejects.toThrow(/already shipped/i);
    expect(state.deletes).toEqual([]);
  });
});
