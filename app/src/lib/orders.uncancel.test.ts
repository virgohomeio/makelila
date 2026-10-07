// Undoing a cancellation made in error (Sales › Cancelled › "Move back to
// Pending"). #1184 Juanita M Wells was cancelled with the reason "test" and
// there was no way back short of the database.
//
// The two writes that matter are (a) the order returns to 'pending' with the
// cancel stamps cleared and (b) the cancellation record stops being a live
// refund request. The rest of this file is the refusals: an order whose money
// has moved must not come back to life.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: {
    order: any;
    cancellations: any[];
    updates: Array<{ table: string; patch: any }>;
    deletes: string[];
  } = { order: null, cancellations: [], updates: [], deletes: [] };

  const terminal = (result: any): any => {
    const p: any = Promise.resolve(result);
    for (const m of ['eq', 'is', 'in', 'select', 'order', 'or'] as const) p[m] = () => terminal(result);
    p.single = () => Promise.resolve(result);
    p.maybeSingle = () => Promise.resolve(result);
    return p;
  };

  const rowsFor = (table: string) =>
    table === 'orders' ? state.order
    : table === 'order_cancellations' ? state.cancellations
    : null;

  const fromMock = vi.fn((table: string) => ({
    select: () => terminal({ data: rowsFor(table), error: null }),
    update: (patch: any) => { state.updates.push({ table, patch }); return terminal({ data: null, error: null }); },
    delete: () => { state.deletes.push(table); return terminal({ data: [], error: null }); },
    insert: () => terminal({ data: null, error: null }),
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

// The refund guard has its own tests (orders.refundGuard.test.ts); here it is a
// switch, so the refusal can be exercised without building refund_approvals rows.
const { refundFlag } = vi.hoisted(() => ({ refundFlag: { current: null as any } }));
vi.mock('./refundedOrders', () => ({
  refundFlagForOrderId: () => Promise.resolve(refundFlag.current),
  refundFlagTitle: () => 'This order was refunded — $4,999.00 paid back. Do not ship it.',
}));

import { uncancelOrder, bucketOrders, type Order } from './orders';

const patchFor = (table: string) => state.updates.find(u => u.table === table)?.patch;

beforeEach(() => {
  state.updates = [];
  state.deletes = [];
  refundFlag.current = null;
  state.order = {
    id: 'o-1', order_ref: '#1184', kind: 'sale', status: 'cancelled',
    financial_status: 'paid',
  };
  state.cancellations = [
    { id: 'c-1', status: 'submitted', refund_approval_id: null, ops_notes: null },
  ];
});

describe('uncancelOrder', () => {
  it('returns the order to Pending and clears the cancellation stamps', async () => {
    await uncancelOrder('o-1');

    expect(patchFor('orders')).toEqual({
      status: 'pending',
      cancelled_at: null,
      cancelled_reason: null,
      dispositioned_by: null,
      dispositioned_at: null,
    });
  });

  it('lands the order in Sales › Pending, where the tab router can see it', async () => {
    await uncancelOrder('o-1');
    const revived = {
      ...state.order, ...patchFor('orders'),
      kind: 'sale', customer_name: 'Juanita M Wells', created_at: '2026-08-01T00:00:00Z',
    } as unknown as Order;
    const buckets = bucketOrders([revived], new Set(), new Set());
    expect(buckets.cancelled).toEqual([]);
    expect(buckets.pending.map(o => o.id)).toEqual(['o-1']);
  });

  it('withdraws the cancellation record so it stops being a live refund request', async () => {
    await uncancelOrder('o-1');
    const patch = patchFor('order_cancellations');
    // 'completed' rather than deleted: order_cancellations has no DELETE policy
    // and its status CHECK allows only submitted|completed.
    expect(patch).toMatchObject({ status: 'completed', processed_by: 'user-1' });
    expect(patch.ops_notes).toMatch(/moved back to Pending/i);
    expect(state.deletes).toEqual([]);
  });

  it('leaves a cancellation record that is already closed alone', async () => {
    state.cancellations = [
      { id: 'c-1', status: 'completed', refund_approval_id: null, ops_notes: 'handled' },
    ];
    await uncancelOrder('o-1');
    expect(patchFor('order_cancellations')).toBeUndefined();
    expect(patchFor('orders')).toMatchObject({ status: 'pending' });
  });

  it('refuses once the cancellation has become a refund request', async () => {
    state.cancellations = [
      { id: 'c-1', status: 'submitted', refund_approval_id: 'r-9', ops_notes: null },
    ];
    await expect(uncancelOrder('o-1')).rejects.toThrow(/already been compiled into a refund/i);
    expect(state.updates).toEqual([]);
  });

  it('refuses an order Shopify has already refunded or voided', async () => {
    state.order = { ...state.order, financial_status: 'refunded' };
    await expect(uncancelOrder('o-1')).rejects.toThrow(/money has already gone back/i);

    state.order = { ...state.order, financial_status: 'voided' };
    await expect(uncancelOrder('o-1')).rejects.toThrow(/money has already gone back/i);
    expect(state.updates).toEqual([]);
  });

  it('refuses an order with a refund against it', async () => {
    refundFlag.current = { level: 'order', settled: true, refundId: 'r-1', refundedAt: null, amountUsd: 4999 };
    await expect(uncancelOrder('o-1')).rejects.toThrow(/Cannot move this order back to Pending/i);
    expect(state.updates).toEqual([]);
  });

  it('lets through a refund on a DIFFERENT order of the same customer', async () => {
    refundFlag.current = { level: 'customer', settled: true, refundId: 'r-1', refundedAt: null, amountUsd: 4999 };
    await uncancelOrder('o-1');
    expect(patchFor('orders')).toMatchObject({ status: 'pending' });
  });

  it('refuses a replacement — its unit, parts and ticket were given back', async () => {
    state.order = { ...state.order, kind: 'replacement' };
    await expect(uncancelOrder('o-1')).rejects.toThrow(/Only a sale can be moved back to Pending/i);
    expect(state.updates).toEqual([]);
  });

  it('refuses an order that is not cancelled', async () => {
    state.order = { ...state.order, status: 'approved' };
    await expect(uncancelOrder('o-1')).rejects.toThrow(/not cancelled/i);
    expect(state.updates).toEqual([]);
  });
});
