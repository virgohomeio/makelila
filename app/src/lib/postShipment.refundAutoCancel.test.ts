// Creating a refund card is what puts a customer INTO the refund workflow, so
// it is the moment everything still in flight for them has to stop. These tests
// cover the wiring only — which side effect fires, with what, and what happens
// when it fails. What counts as "in flight" is refundAutoCancel.test.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, autoCancelMock, logActionMock } = vi.hoisted(() => ({
  state: { refundInsert: null as any },
  autoCancelMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (row: any) => {
        if (table === 'refund_approvals') state.refundInsert = row;
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'refund-new' }, error: null }) }) };
      },
    }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'reina-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'reina-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve()) }));
vi.mock('./refundAutoCancel', () => ({
  cancelOpenOrdersForRefund: autoCancelMock,
}));

import { submitRefundRequest } from './postShipment';

const CLEAN = { cancelled: [], failed: [], skippedNoEmail: false };

describe('creating a refund card cancels what is still in flight', () => {
  beforeEach(() => {
    state.refundInsert = null;
    logActionMock.mockClear();
    autoCancelMock.mockReset();
    autoCancelMock.mockResolvedValue(CLEAN);
  });

  it('fires for the card it just created, against that card\'s customer', async () => {
    const id = await submitRefundRequest({
      customer_name: 'Jane Doe',
      customer_email: 'jane@example.com',
      refund_amount_usd: 3499,
    });

    expect(id).toBe('refund-new');
    expect(autoCancelMock).toHaveBeenCalledWith({
      refundId: 'refund-new',
      customerEmail: 'jane@example.com',
      customerName: 'Jane Doe',
    });
  });

  it('hands the result to the caller so the operator is told what went', async () => {
    const outcome = {
      cancelled: [{ order_ref: '#1231', kind: 'sale', wasQueued: true }],
      failed: [],
      skippedNoEmail: false,
    };
    autoCancelMock.mockResolvedValue(outcome);
    const onAutoCancel = vi.fn();

    await submitRefundRequest(
      { customer_name: 'Jane Doe', customer_email: 'jane@example.com', refund_amount_usd: 3499 },
      { onAutoCancel },
    );

    expect(onAutoCancel).toHaveBeenCalledWith(outcome);
  });

  it('still returns the card when the cancels blow up, and says so', async () => {
    // The insert has already committed. Throwing here would tell the operator
    // the refund could not be created when it plainly was.
    autoCancelMock.mockRejectedValue(new Error('orders unreachable'));
    const onAutoCancel = vi.fn();

    const id = await submitRefundRequest(
      { customer_name: 'Jane Doe', customer_email: 'jane@example.com', refund_amount_usd: 3499 },
      { onAutoCancel },
    );

    expect(id).toBe('refund-new');
    expect(state.refundInsert).toMatchObject({ status: 'submitted' });
    // Not silent: the failure reaches both the audit trail and the operator.
    expect(logActionMock).toHaveBeenCalledWith(
      'refund_auto_cancel_failed', 'refund-new', 'orders unreachable',
    );
    expect(onAutoCancel).toHaveBeenCalledWith(
      expect.objectContaining({ failed: [expect.objectContaining({ message: 'orders unreachable' })] }),
    );
  });

  it('runs even when the caller has nowhere to report it', async () => {
    await submitRefundRequest({ customer_name: 'Jane Doe', refund_amount_usd: 100 });
    expect(autoCancelMock).toHaveBeenCalledTimes(1);
  });
});
