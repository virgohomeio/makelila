// A customer cancellation form is a refund request the moment it lands — the
// same as a return form. These tests pin the two halves of that:
//   1. pendingCancellationRefunds — which rows show as cards on the Refunds
//      board's first column (submitted, not yet turned into a refund).
//   2. processCancellation(id, true) — compiling one opens the refund card in
//      Completeness ('submitted'), NOT straight in front of the Return Manager.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, state } = vi.hoisted(() => {
  const state: { cancellation: any; refundInsert: any; cancellationPatch: any } = {
    cancellation: null, refundInsert: null, cancellationPatch: null,
  };

  const fromMock = vi.fn((table: string) => ({
    select: (_cols?: string) => ({
      eq: (_col: string, _val: string) => ({
        single: () => Promise.resolve(
          table === 'order_cancellations'
            ? { data: state.cancellation, error: state.cancellation ? null : { message: 'not found' } }
            : { data: null, error: { message: 'unexpected read' } },
        ),
      }),
    }),
    insert: (row: any) => {
      if (table === 'refund_approvals') state.refundInsert = row;
      return {
        select: (_c?: string) => ({
          single: () => Promise.resolve({ data: { id: 'refund-1' }, error: null }),
        }),
      };
    },
    update: (patch: any) => ({
      eq: (_col: string, _val: string) => {
        if (table === 'order_cancellations') state.cancellationPatch = patch;
        return Promise.resolve({ error: null });
      },
    }),
  }));

  return { fromMock, state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'reina-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'reina-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));
vi.mock('./templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve()) }));
// No invoice for this customer → the opening amount falls back to the order
// amount off the cancellation form.
vi.mock('./invoices', () => ({
  invoicesForCustomerEmail: vi.fn(() => Promise.resolve([])),
  pickRefundBasisInvoice: vi.fn(() => null),
  invoiceAmountCad: vi.fn(() => null),
}));

import {
  pendingCancellationRefunds, processCancellation, type OrderCancellation,
} from './postShipment';

function cancellation(over: Partial<OrderCancellation> = {}): OrderCancellation {
  return {
    id: 'canc-1',
    order_ref: '#1107',
    customer_name: 'Dana Reyes',
    customer_email: 'dana@example.com',
    customer_phone: null,
    preferred_contact: 'email',
    order_date: null,
    product_name: 'LILA Pro Composter',
    order_amount_usd: 1049,
    purchase_channel: 'Online Store',
    reason: 'Ordered by mistake',
    description: null,
    product_received: false,
    desired_resolution: 'Full cancellation before shipment',
    status: 'submitted',
    ops_notes: null,
    processed_by: null,
    processed_at: null,
    refund_approval_id: null,
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    ...over,
  };
}

describe('pendingCancellationRefunds', () => {
  it('queues every freshly submitted cancellation, newest first', () => {
    const older = cancellation({ id: 'a', created_at: '2026-08-01T00:00:00Z' });
    const newer = cancellation({ id: 'b', created_at: '2026-08-09T00:00:00Z' });
    expect(pendingCancellationRefunds([older, newer]).map(c => c.id)).toEqual(['b', 'a']);
  });

  it('drops rows already compiled into a refund', () => {
    const linked = cancellation({ id: 'c', refund_approval_id: 'refund-9' });
    expect(pendingCancellationRefunds([linked])).toEqual([]);
  });

  it('drops rows an operator already closed out', () => {
    const done = cancellation({ id: 'd', status: 'completed' });
    expect(pendingCancellationRefunds([done])).toEqual([]);
  });
});

describe('processCancellation → refund card', () => {
  beforeEach(() => {
    state.cancellation = cancellation();
    state.refundInsert = null;
    state.cancellationPatch = null;
  });

  it('opens the refund in Completeness, at the order amount, and links it back', async () => {
    await processCancellation('canc-1', true);

    expect(state.refundInsert).toMatchObject({
      customer_name: 'Dana Reyes',
      customer_email: 'dana@example.com',
      refund_amount_usd: 1049,
      status: 'submitted',       // Completeness — same landing spot as a return
      submitted_by: 'reina-1',
    });
    expect(state.refundInsert.reason).toContain('Order cancellation');
    expect(state.cancellationPatch).toMatchObject({
      status: 'completed',
      refund_approval_id: 'refund-1',
    });
  });

  it('closes the cancellation with no refund when nothing was charged', async () => {
    await processCancellation('canc-1', false, undefined, 'Never charged — cart abandoned');

    expect(state.refundInsert).toBeNull();
    expect(state.cancellationPatch).toMatchObject({
      status: 'completed',
      refund_approval_id: null,
    });
    expect(state.cancellationPatch.ops_notes).toContain('Never charged');
  });
});
