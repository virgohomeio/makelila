// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks; the runtime
// behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, getUserMock, logActionMock, flagMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getUserMock: vi.fn(() => Promise.resolve({ data: { user: { id: 'user-1' } } })),
  logActionMock: vi.fn(() => Promise.resolve()),
  flagMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: getUserMock }, rpc: vi.fn() },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./refundedOrders', async () => {
  const actual = await vi.importActual<typeof import('./refundedOrders')>('./refundedOrders');
  return { ...actual, refundFlagForOrderId: flagMock };
});

import { enqueueForFulfillment, disposition } from './orders';

const settledOnThisOrder = {
  level: 'order' as const, settled: true,
  refundId: 'refund-1', refundedAt: '2026-08-24T00:00:00Z', amountUsd: 833.38,
};

describe('enqueueForFulfillment refund guard', () => {
  let queueInsert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queueInsert = vi.fn(() => Promise.resolve({ error: null }));
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) =>
      table === 'fulfillment_queue' ? { insert: queueInsert } : ({} as any));
    logActionMock.mockClear();
    flagMock.mockReset();
  });

  it('refuses to queue an order that has already been refunded', async () => {
    flagMock.mockResolvedValue(settledOnThisOrder);
    await expect(enqueueForFulfillment('order-1')).rejects.toThrow(/refunded/i);
    expect(queueInsert).not.toHaveBeenCalled();
  });

  it('refuses while a refund for the order is still in review', async () => {
    flagMock.mockResolvedValue({ ...settledOnThisOrder, settled: false });
    await expect(enqueueForFulfillment('order-1')).rejects.toThrow(/refund/i);
    expect(queueInsert).not.toHaveBeenCalled();
  });

  it('queues normally when only ANOTHER order of the customer was refunded', async () => {
    // They bought again. That is a judgement call for the operator, made on the
    // badge — not something to block.
    flagMock.mockResolvedValue({ ...settledOnThisOrder, level: 'customer' });
    await enqueueForFulfillment('order-1');
    expect(queueInsert).toHaveBeenCalledWith(expect.objectContaining({ order_id: 'order-1' }));
  });

  it('queues normally when the order is clean', async () => {
    flagMock.mockResolvedValue(null);
    await enqueueForFulfillment('order-1');
    expect(queueInsert).toHaveBeenCalled();
  });

  it('queues when the refund lookup itself fails — the guard never strands the queue', async () => {
    flagMock.mockRejectedValue(new Error('network'));
    await enqueueForFulfillment('order-1');
    expect(queueInsert).toHaveBeenCalled();
  });
});

describe('disposition refund guard', () => {
  let update: ReturnType<typeof vi.fn>;
  let eq: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eq = vi.fn(() => Promise.resolve({ error: null }));
    update = vi.fn(() => ({ eq }));
    fromMock.mockReset();
    fromMock.mockImplementation(() => ({ update }));
    logActionMock.mockClear();
    flagMock.mockReset();
  });

  const order = { id: 'order-1', order_ref: '#1231', customer_name: 'Lisa Clarke' };

  it('refuses to approve a refunded order — approving is what queues it', async () => {
    // auto_enqueue_approved_order fires on this UPDATE, so blocking the enqueue
    // alone would be too late.
    flagMock.mockResolvedValue(settledOnThisOrder);
    await expect(disposition(order, 'approved')).rejects.toThrow(/refunded/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('still allows flagging or holding a refunded order', async () => {
    flagMock.mockResolvedValue(settledOnThisOrder);
    await disposition(order, 'held', 'refund in progress');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held' }));
  });

  it('approves a clean order', async () => {
    flagMock.mockResolvedValue(null);
    await disposition(order, 'approved');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });
});
