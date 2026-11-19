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

/** A supabase double just wide enough for the withdraw path.
 *
 *  `assignedUnits` is the fulfillment_queue_units side: the set of machines on
 *  the row. Left empty, the release falls back to the row's own
 *  assigned_serial, which is what a pre-migration database does. */
function harness(queueRows: QueueRow[], unitStatus = 'reserved', assignedUnits: string[] = []) {
  const state = {
    deletedQueueIds: [] as string[],
    unitUpdates: [] as any[],
    slotUpdates: [] as any[],
    releasedSerials: [] as string[],
    clearedLinkQueueIds: [] as string[],
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
    if (table === 'fulfillment_queue_units') {
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({
              data: assignedUnits.map((unit_serial, i) => ({
                unit_serial, assigned_at: `2026-05-0${i + 1}T00:00:00Z`,
              })),
              error: null,
            }),
          }),
        }),
        delete: () => ({
          eq: (_c: string, id: string) => {
            state.clearedLinkQueueIds.push(id);
            return Promise.resolve({ error: null });
          },
        }),
      } as any;
    }
    if (table === 'units') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { status: unitStatus } }) }) }),
        update: (patch: any) => { state.unitUpdates.push(patch); return {
          eq: (_c: string, serial: string) => {
            state.releasedSerials.push(serial);
            return Promise.resolve({ error: null });
          },
        }; },
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

  it('frees every machine on a multi-unit order, not just the first', async () => {
    // The whole point of the child table: releasing only assigned_serial would
    // leave two machines reserved against an order that is no longer queued.
    const state = harness(
      [{ id: 'q1', order_id: 'order-1', step: 2, assigned_serial: 'LL01-0001', fulfilled_at: null }],
      'reserved',
      ['LL01-0001', 'LL01-0002', 'LL01-0003'],
    );

    await expect(withdrawOrderFromQueue('order-1', 'refunded')).resolves.toBe(true);

    expect(state.releasedSerials).toEqual(['LL01-0001', 'LL01-0002', 'LL01-0003']);
    expect(state.unitUpdates).toHaveLength(3);
    expect(state.slotUpdates).toHaveLength(3);
    // The links are cleared, and the row itself is deleted after the release —
    // ON DELETE CASCADE would otherwise take the record of what to free.
    expect(state.clearedLinkQueueIds).toEqual(['q1']);
    expect(state.deletedQueueIds).toEqual(['q1']);
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
