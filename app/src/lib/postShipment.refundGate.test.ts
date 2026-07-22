// FR-2 (Refund & Return Approval PRD v0.2): the return/inspection gate must
// block Manager Review approval — not only Finance Review — so incomplete cards
// never reach the Return Manager. BR-7: genuine-defect units are discarded by
// the customer (no physical return) and must still be refundable.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── hoisted mock state ──────────────────────────────────────────────────────
const { fromMock, getUserMock, logActionMock, state } = vi.hoisted(() => {
  const state: {
    approval: any;
    ret: any;
    updatePatch: any;
    updateCalled: boolean;
  } = { approval: null, ret: null, updatePatch: null, updateCalled: false };

  const getUserMock = vi.fn(() =>
    Promise.resolve({ data: { user: { id: 'mgr-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());

  // Dispatch by table + operation. select→eq→single reads; update→eq writes.
  const fromMock = vi.fn((table: string) => ({
    select: (_cols?: string) => ({
      eq: (_col: string, _val: string) => ({
        single: () =>
          Promise.resolve(
            table === 'refund_approvals'
              ? { data: state.approval, error: state.approval ? null : { message: 'not found' } }
              : { data: state.ret, error: state.ret ? null : { message: 'not found' } },
          ),
      }),
    }),
    update: (patch: any) => ({
      eq: (_col: string, _val: string) => {
        state.updateCalled = true;
        state.updatePatch = patch;
        return Promise.resolve({ error: null });
      },
    }),
  }));

  return { fromMock, getUserMock, logActionMock, state };
});

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, auth: { getUser: getUserMock } },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

// ── import after mocks ──────────────────────────────────────────────────────
import {
  managerApprove,
  submitToManager,
  confirmPurchaserLinkage,
  returnStatusAllowsRefund,
  hasValidPurchaserLinkage,
  type ReturnStatus,
} from './postShipment';

beforeEach(() => {
  state.approval = null;
  state.ret = null;
  state.updatePatch = null;
  state.updateCalled = false;
  vi.clearAllMocks();
});

describe('returnStatusAllowsRefund', () => {
  const allowed: ReturnStatus[] = ['received', 'inspected', 'refunded', 'closed', 'discarded'];
  const blocked: ReturnStatus[] = ['created', 'pickup_scheduled', 'picked_up', 'denied'];

  it.each(allowed)('allows refund when linked return is "%s"', (status) => {
    expect(returnStatusAllowsRefund(status)).toBe(true);
  });

  it.each(blocked)('blocks refund when linked return is "%s"', (status) => {
    expect(returnStatusAllowsRefund(status)).toBe(false);
  });
});

describe('managerApprove — return/inspection gate (FR-2)', () => {
  it('blocks approval when the linked return has not been received', async () => {
    state.approval = { id: 'r1', return_id: 'ret1', status: 'manager_review' };
    state.ret = { id: 'ret1', status: 'pickup_scheduled' };

    await expect(managerApprove('r1')).rejects.toThrow(/pickup_scheduled|received/i);
    expect(state.updateCalled).toBe(false);
  });

  it('allows approval when the linked return has been received', async () => {
    state.approval = { id: 'r1', return_id: 'ret1', status: 'manager_review' };
    state.ret = { id: 'ret1', status: 'received' };

    await managerApprove('r1', 'looks good');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.status).toBe('finance_review');
  });

  it('allows approval for genuine-defect discard cases (BR-7)', async () => {
    state.approval = { id: 'r1', return_id: 'ret1', status: 'manager_review' };
    state.ret = { id: 'ret1', status: 'discarded' };

    await managerApprove('r1');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.status).toBe('finance_review');
  });

  it('allows approval when there is no linked return (nothing to gate on)', async () => {
    state.approval = { id: 'r1', return_id: null, status: 'manager_review' };

    await managerApprove('r1');
    expect(state.updateCalled).toBe(true);
  });
});

// FR-11 / BR-14 / BR-15: valid purchaser linkage required before a refund can
// be approved — prevents refunding the wrong party on gift/household cases.
describe('hasValidPurchaserLinkage', () => {
  const base = {
    is_purchaser: false as boolean | null,
    purchaser_name: null as string | null,
    purchaser_email: null as string | null,
    purchase_proof: null as string | null,
    purchaser_linkage_confirmed_at: null as string | null,
  };

  it('passes when there is no linked return', () => {
    expect(hasValidPurchaserLinkage(null)).toBe(true);
  });
  it('passes when the filer is the purchaser (is_purchaser=true)', () => {
    expect(hasValidPurchaserLinkage({ ...base, is_purchaser: true })).toBe(true);
  });
  it('passes for an ops/legacy return with no attestation (is_purchaser=null)', () => {
    expect(hasValidPurchaserLinkage({ ...base, is_purchaser: null })).toBe(true);
  });
  it('blocks a gift filer with no purchaser identity or proof', () => {
    expect(hasValidPurchaserLinkage(base)).toBe(false);
  });
  it('blocks a gift filer who named the purchaser but attached no proof', () => {
    expect(hasValidPurchaserLinkage({ ...base, purchaser_name: 'Annie Wu' })).toBe(false);
  });
  it('passes a gift filer with purchaser identity AND proof', () => {
    expect(hasValidPurchaserLinkage({ ...base, purchaser_name: 'Annie Wu', purchase_proof: 'receipt.pdf' })).toBe(true);
  });
  it('passes when the Return Manager has confirmed linkage (BR-15 override)', () => {
    expect(hasValidPurchaserLinkage({ ...base, purchaser_linkage_confirmed_at: '2026-07-22T00:00:00Z' })).toBe(true);
  });
});

describe('managerApprove — purchaser-linkage gate (FR-11)', () => {
  it('blocks approval when a gift return lacks purchaser linkage', async () => {
    state.approval = { id: 'r1', return_id: 'ret1', status: 'manager_review' };
    state.ret = { id: 'ret1', status: 'received', is_purchaser: false, purchaser_name: null, purchaser_email: null, purchase_proof: null, purchaser_linkage_confirmed_at: null };

    await expect(managerApprove('r1')).rejects.toThrow(/purchaser|linkage/i);
    expect(state.updateCalled).toBe(false);
  });

  it('allows approval once the manager has confirmed linkage', async () => {
    state.approval = { id: 'r1', return_id: 'ret1', status: 'manager_review' };
    state.ret = { id: 'ret1', status: 'received', is_purchaser: false, purchaser_name: null, purchaser_email: null, purchase_proof: null, purchaser_linkage_confirmed_at: '2026-07-22T00:00:00Z' };

    await managerApprove('r1');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.status).toBe('finance_review');
  });
});

describe('confirmPurchaserLinkage (BR-15 override)', () => {
  it('stamps the confirmation on the return', async () => {
    state.ret = { id: 'ret1', status: 'received' };

    await confirmPurchaserLinkage('ret1');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.purchaser_linkage_confirmed_at).toEqual(expect.any(String));
    expect(state.updatePatch.purchaser_linkage_confirmed_by).toBe('mgr-1');
  });
});

describe('submitToManager (FR-3)', () => {
  it('promotes a submitted card to manager_review', async () => {
    state.approval = { id: 'r1', status: 'submitted' };

    await submitToManager('r1');
    expect(state.updateCalled).toBe(true);
    expect(state.updatePatch.status).toBe('manager_review');
  });

  it('refuses to submit a card that is not in the submitted state', async () => {
    state.approval = { id: 'r1', status: 'manager_review' };

    await expect(submitToManager('r1')).rejects.toThrow(/manager_review|submit/i);
    expect(state.updateCalled).toBe(false);
  });
});
