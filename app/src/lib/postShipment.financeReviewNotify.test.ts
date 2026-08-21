// FR-9d (2026-08-21): the Finance Officer must be emailed the moment a refund
// card lands in Finance Review.
//
// Reported by Julie: "I'm not getting emails when refund cards get moved to the
// finance queue." Confirmed against prod — the two neighbouring transitions each
// send an internal notice (financeApprove → refund_queued_executor, executeRefund
// → refund_executed_am) but the manager_review → finance_review hop sent nothing
// at all. The only thing that ever reached her was send-refund-reminders, the
// 3-day *overdue* digest, so a freshly-approved card sat silent for up to four
// days before she heard about it.
//
// Both doors into the column must knock:
//   managerApprove()                      — manager_review → finance_review
//   sendRefundBack(id, 'finance_review')  — refund_queue   → finance_review
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── hoisted mock state ──────────────────────────────────────────────────────
const { fromMock, getSessionMock, getUserMock, logActionMock, sendTemplateMock, state } = vi.hoisted(() => {
  const state: { approval: any; ret: any; updatePatch: any } = {
    approval: null, ret: null, updatePatch: null,
  };

  const getSessionMock = vi.fn(() => Promise.resolve({ data: { session: { user: { id: 'mgr-1' } } } }));
  const getUserMock = vi.fn(() => Promise.resolve({ data: { user: { id: 'mgr-1' } } }));
  const logActionMock = vi.fn(() => Promise.resolve());
  const sendTemplateMock = vi.fn(() => Promise.resolve({ message_id: 'm1', resend_id: 'r1' }));

  const fromMock = vi.fn((table: string) => ({
    select: (_cols?: string) => ({
      eq: (_col: string, _val: string) => ({
        single: () => Promise.resolve(
          table === 'refund_approvals'
            ? { data: state.approval, error: state.approval ? null : { message: 'not found' } }
            : { data: state.ret, error: state.ret ? null : { message: 'not found' } },
        ),
        maybeSingle: () => Promise.resolve(
          table === 'refund_approvals'
            ? { data: state.approval, error: null }
            : { data: state.ret, error: null },
        ),
      }),
    }),
    update: (patch: any) => ({
      eq: (_col: string, _val: string) => {
        state.updatePatch = patch;
        return Promise.resolve({ error: null });
      },
    }),
  }));

  return { fromMock, getSessionMock, getUserMock, logActionMock, sendTemplateMock, state };
});

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getSession: getSessionMock, getUser: getUserMock } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./templates', () => ({ sendTemplate: sendTemplateMock }));

// ── import after mocks ──────────────────────────────────────────────────────
import {
  managerApprove,
  sendRefundBack,
  REFUND_FINANCE_REVIEWER,
} from './postShipment';

// A card sitting in Manager Review with no linked return, so the FR-2 gate and
// the FR-11 purchaser-linkage check are both no-ops and we isolate the email.
const CARD = {
  id: 'ref-1',
  return_id: null,
  status: 'manager_review',
  customer_email: 'lisa@example.com',
  customer_name: 'Lisa Clarke',
  refund_amount_usd: 141.25,
};

beforeEach(() => {
  state.approval = { ...CARD };
  state.ret = null;
  state.updatePatch = null;
  vi.clearAllMocks();
});

describe('Finance Review entry notification (FR-9d)', () => {
  it('emails the Finance Officer when the manager approves a card into Finance Review', async () => {
    await managerApprove('ref-1', 'looks good');

    expect(state.updatePatch.status).toBe('finance_review');
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);

    const arg = sendTemplateMock.mock.calls[0][0] as any;
    expect(arg.template_key).toBe('refund_finance_review');
    expect(arg.to).toBe('yueli@virgohome.io');
    expect(arg.related_refund_id).toBe('ref-1');
  });

  it('addresses her as Julie and carries the customer + amount so the mail is actionable', async () => {
    await managerApprove('ref-1');

    const vars = (sendTemplateMock.mock.calls[0][0] as any).variables;
    expect(vars.finance_first_name).toBe('Julie');
    expect(vars.customer_name).toBe('Lisa Clarke');
    expect(vars.amount).toBe('$141.25');
    expect(vars.refund_url).toContain('tab=refunds');
  });

  it('exports the finance reviewer address so routing is a one-line change', () => {
    expect(REFUND_FINANCE_REVIEWER).toBe('yueli@virgohome.io');
  });

  // The card also re-enters her column when the executor sends it back from the
  // Refund Queue — that door was silent too.
  it('emails the Finance Officer when a card is sent back into Finance Review', async () => {
    state.approval = { ...CARD, status: 'refund_queue' };

    await sendRefundBack('ref-1', 'finance_review');

    expect(state.updatePatch.status).toBe('finance_review');
    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    expect((sendTemplateMock.mock.calls[0][0] as any).to).toBe('yueli@virgohome.io');
  });

  it('does NOT email her when a card is sent back to an earlier column', async () => {
    state.approval = { ...CARD, status: 'finance_review' };

    await sendRefundBack('ref-1', 'manager_review');
    await sendRefundBack('ref-1', 'submitted');

    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  // Mirrors FR-9a: a mail failure must never roll back or appear to fail an
  // approval that has already committed, or the card looks stuck when it moved.
  it('never fails the approval when the email send throws', async () => {
    sendTemplateMock.mockRejectedValueOnce(new Error('Resend 500'));

    await expect(managerApprove('ref-1')).resolves.toBeUndefined();
    expect(state.updatePatch.status).toBe('finance_review');
    expect(logActionMock).toHaveBeenCalled();
  });
});
