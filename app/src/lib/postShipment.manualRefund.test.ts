// A manually-created refund card (Create Manual Refund) — for cases that
// arrive by email or phone with no return form and no cancellation form behind
// them. The card must be indistinguishable from any other refund once created,
// so it goes through submitRefundRequest and lands in Completeness.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => {
  const state: { refundInsert: any } = { refundInsert: null };
  return { state };
});

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
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));
vi.mock('./templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve()) }));
vi.mock('./invoices', () => ({
  invoicesForCustomerEmail: vi.fn(() => Promise.resolve([])),
  pickRefundBasisInvoice: vi.fn(() => null),
  invoiceAmountCad: vi.fn(() => null),
}));

import { manualRefundReason, submitRefundRequest } from './postShipment';
import { resolvePurchaserId } from './customers';

describe('manualRefundReason', () => {
  it('is just the category when no detail is typed', () => {
    expect(manualRefundReason('product_defect')).toBe('Product Defect');
    expect(manualRefundReason('shipping_damage', '   ')).toBe('Shipping Damage');
  });

  it('appends the operator detail when there is one', () => {
    expect(manualRefundReason('software_issue', 'App never paired'))
      .toBe('Software Issue — App never paired');
  });

  it('trims what the operator typed', () => {
    expect(manualRefundReason('financing', '  Sezzle chargeback  '))
      .toBe('Financing — Sezzle chargeback');
  });
});

// FR-6: the directory row picked in the modal may be a USER acting for someone
// else. The refund books against the purchaser, never the user.
describe('who a manual refund is opened for', () => {
  it('is the customer themselves when they are their own purchaser', () => {
    expect(resolvePurchaserId({ id: 'cust-1', purchaser_id: null })).toBe('cust-1');
  });

  it('is the purchaser when the picked row is a user acting for them', () => {
    expect(resolvePurchaserId({ id: 'user-1', purchaser_id: 'buyer-9' })).toBe('buyer-9');
  });
});

describe('the card a manual refund creates', () => {
  beforeEach(() => { state.refundInsert = null; });

  // Same landing spot as a return-born card: Completeness for verification,
  // not straight in front of the Return Manager.
  it('lands in Completeness with no return attached', async () => {
    const id = await submitRefundRequest({
      customer_name: 'Dana Reyes',
      customer_email: 'dana@example.com',
      refund_amount_usd: 1049,
      reason: manualRefundReason('customer_service', 'Promised a refund on the call'),
    });

    expect(id).toBe('refund-new');
    expect(state.refundInsert).toMatchObject({
      customer_name: 'Dana Reyes',
      customer_email: 'dana@example.com',
      status: 'submitted',
      submitted_by: 'reina-1',
      reason: 'Customer Service — Promised a refund on the call',
    });
    expect(state.refundInsert.return_id).toBeUndefined();
  });
});
