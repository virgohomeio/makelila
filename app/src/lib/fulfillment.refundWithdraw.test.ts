// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks; the runtime
// behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, getUserMock, logActionMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getUserMock: vi.fn(() => Promise.resolve({ data: { user: { id: 'user-1' } } })),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: getUserMock }, rpc: vi.fn() },
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./orders', () => ({ cancelOrder: vi.fn(), returnOrderToReview: vi.fn() }));

import { withdrawOrderFromQueue } from './fulfillment';

type QueueRow = {
  id: string; order_id: string; step: number;
  assigned_serial: string | null; fulfilled_at: string | null;
};

/** A supabase double just wide enough for the withdraw path. */
function harness(queueRows: QueueRow[], unitStatus = 'reserved') {
  const state = {
    deletedQueueIds: [] as string[],
    unitUpdates: [] as any[],
    slotUpdates: [] as any[],
  };
  fromMock.mockImplementation((table: string) => {
    if (table === 'fulfillment_queue') {
      return {
        select: () => ({
          eq: (_c: string, orderId: string) => ({
            is: () => ({
              maybeSingle: () => Promise.resolve({
                data: queueRows.find(r => r.order_id === orderId && !r.fulfilled_at) ?? null,
                error: null,
              }),
            }),
          }),
        }),
        delete: () => ({
          eq: (_c: string, id: string) => ({
            select: () => {
              state.deletedQueueIds.push(id);
              return Promise.resolve({ data: [{ id }], error: null });
            },
          }),
        }),
      } as any;
    }
    if (table === 'units') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { status: unitStatus } }) }) }),
        update: (patch: any) => { state.unitUpdates.push(patch); return { eq: () => Promise.resolve({ error: null }) }; },
      } as any;
    }
    if (table === 'shelf_slots') {
      return {
        update: (patch: any) => { state.slotUpdates.push(patch); return { eq: () => Promise.resolve({ error: null }) }; },
      } as any;
    }
    return {} as any;
  });
  return state;
}

describe('withdrawOrderFromQueue', () => {
  beforeEach(() => {
    fromMock.mockReset();
    logActionMock.mockClear();
  });

  it('pulls an unshipped order out of the queue and frees its unit', async () => {
    const state = harness([
      { id: 'q1', order_id: 'order-1', step: 2, assigned_serial: 'LL01-0001', fulfilled_at: null },
    ]);

    await expect(withdrawOrderFromQueue('order-1', 'refunded')).resolves.toBe(true);

    expect(state.deletedQueueIds).toEqual(['q1']);
    // The machine picked for a refunded order goes back into sellable stock.
    expect(state.unitUpdates[0]).toMatchObject({ status: 'ready', customer_order_ref: null });
    expect(state.slotUpdates[0]).toMatchObject({ status: 'available' });
    expect(logActionMock).toHaveBeenCalledWith('fq_withdrawn_refunded', 'q1', expect.stringContaining('refunded'));
  });

  it('reports false when the order was never queued', async () => {
    const state = harness([]);
    await expect(withdrawOrderFromQueue('order-1', 'refunded')).resolves.toBe(false);
    expect(state.deletedQueueIds).toEqual([]);
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('leaves an already-shipped order alone', async () => {
    // The box is gone. That is a returns problem, not a queue problem — and
    // deleting the row would erase the shipment record.
    const state = harness([
      { id: 'q1', order_id: 'order-1', step: 6, assigned_serial: 'LL01-0001', fulfilled_at: '2026-05-01T00:00:00Z' },
    ]);
    await expect(withdrawOrderFromQueue('order-1', 'refunded')).resolves.toBe(false);
    expect(state.deletedQueueIds).toEqual([]);
  });

  it('handles a queue row with no unit assigned yet', async () => {
    const state = harness([
      { id: 'q1', order_id: 'order-1', step: 1, assigned_serial: null, fulfilled_at: null },
    ]);
    await expect(withdrawOrderFromQueue('order-1', 'refunded')).resolves.toBe(true);
    expect(state.deletedQueueIds).toEqual(['q1']);
    expect(state.unitUpdates).toEqual([]);
  });
});
