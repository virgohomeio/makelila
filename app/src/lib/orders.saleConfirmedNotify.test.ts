// Confirming a sale must tell Customer Service (Reina, 2026-10-07).
//
// Order Review's Confirm button is the hand-off into fulfillment: the status
// UPDATE fires auto_enqueue_approved_order, so the order is in the queue with
// the 2-day SLA clock running the instant it lands. Nothing announced it, so
// the only way to learn a sale had been confirmed was to open the queue and
// notice a row that had not been there before.
//
// What must hold:
//   Confirm                 → one mail to reina@virgohome.io
//   Flag / Hold             → silent (not a confirmation)
//   a confirmed REPLACEMENT → silent (not a sale)
//   a mail failure          → the confirmation still succeeds
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, getUserMock, logActionMock, sendTemplateMock, state } = vi.hoisted(() => {
  const state: { updatePatch: any } = { updatePatch: null };

  const getUserMock = vi.fn(() =>
    Promise.resolve({ data: { user: { id: 'op-1', email: 'pedrum@virgohome.io' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  const sendTemplateMock = vi.fn((_input: any) =>
    Promise.resolve({ message_id: 'm1', resend_id: 'r1' }),
  );

  const fromMock = vi.fn((_table: string) => ({
    update: (patch: any) => ({
      eq: (_col: string, _val: string) => {
        state.updatePatch = patch;
        return Promise.resolve({ error: null });
      },
    }),
  }));

  return { fromMock, getUserMock, logActionMock, sendTemplateMock, state };
});

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: getUserMock } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./templates', () => ({ sendTemplate: sendTemplateMock }));
// The refund guard does its own lookup; a clean order keeps this test on the email.
vi.mock('./refundedOrders', () => ({
  refundFlagForOrderId: vi.fn(() => Promise.resolve(null)),
  refundFlagTitle: vi.fn(() => ''),
}));

import { disposition, SALE_CONFIRMED_NOTIFY } from './orders';

const ORDER = {
  id: 'ord-1',
  order_ref: '#1210',
  customer_name: 'Lisa Clarke',
  total_usd: 2499,
  currency: 'CAD',
  kind: 'sale' as const,
};

beforeEach(() => {
  state.updatePatch = null;
  vi.clearAllMocks();
});

describe('sale-confirmed notification', () => {
  it('emails Customer Service when a sale is confirmed', async () => {
    await disposition(ORDER, 'approved');

    expect(state.updatePatch.status).toBe('approved');
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);

    const arg = sendTemplateMock.mock.calls[0][0] as any;
    expect(arg.template_key).toBe('sale_confirmed');
    expect(arg.to).toBe('reina@virgohome.io');
  });

  it('carries the order, the customer and who confirmed it, so the mail is actionable', async () => {
    await disposition(ORDER, 'approved');

    const vars = (sendTemplateMock.mock.calls[0][0] as any).variables;
    expect(vars.order_ref).toBe('#1210');
    expect(vars.customer_name).toBe('Lisa Clarke');
    expect(vars.confirmed_by).toBe('pedrum@virgohome.io');
    expect(vars.queue_url).toContain('/fulfillment/queue');
    expect(vars.order_url).toContain('ord-1');
  });

  // total_usd holds the order's own currency despite the name, so the mail must
  // never label a CAD total as dollars-unqualified.
  it('states the currency alongside the total', async () => {
    await disposition(ORDER, 'approved');
    expect((sendTemplateMock.mock.calls[0][0] as any).variables.amount).toBe('2499.00 CAD');
  });

  it('says so rather than inventing a total when the order has none', async () => {
    await disposition({ ...ORDER, total_usd: undefined, currency: undefined }, 'approved');
    expect((sendTemplateMock.mock.calls[0][0] as any).variables.amount).toBe('—');
  });

  it('stays quiet on Flag and Hold — neither confirms a sale', async () => {
    await disposition(ORDER, 'flagged', 'address looks wrong');
    await disposition(ORDER, 'held', 'waiting on the customer');

    expect(sendTemplateMock).not.toHaveBeenCalled();
    expect(logActionMock).toHaveBeenCalledTimes(2);
  });

  // A replacement flagged from the fulfillment queue lands back in Order Review
  // and can be confirmed from this same button. It is not a sale.
  it('stays quiet when a replacement is confirmed', async () => {
    await disposition({ ...ORDER, kind: 'replacement' }, 'approved');

    expect(state.updatePatch.status).toBe('approved');
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  // The UPDATE has already committed by the time the mail is sent. An operator
  // who saw Confirm fail would click again — a second order_approve on an order
  // that was already confirmed.
  it('never fails the confirmation when the email send throws', async () => {
    sendTemplateMock.mockRejectedValueOnce(new Error('Resend 500'));

    await expect(disposition(ORDER, 'approved')).resolves.toBeUndefined();
    expect(state.updatePatch.status).toBe('approved');
    expect(logActionMock).toHaveBeenCalledTimes(1);
  });

  it('exports the recipient so re-routing the notice is a one-line change', () => {
    expect(SALE_CONFIRMED_NOTIFY).toBe('reina@virgohome.io');
  });
});
