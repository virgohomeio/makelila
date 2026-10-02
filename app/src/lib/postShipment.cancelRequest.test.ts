// Cancelling a request that should never have been on the board.
//
// Pedrum raised two Sales orders called "Support LILA" to test the workflow and
// cancelled them; both landed in Cancellation Requests as live refund work for
// money nobody ever paid. There was no way out of that column except Reina
// compiling or dismissing them, and no way to record WHY a request was pulled.
//
// Cancelling is not denying. A denial is a decision about a customer's money;
// this says the card should not exist — a test, a duplicate, an intake in
// error — so the case leaves the board and carries the operator's reason with
// it, in the notes thread and in the audit trail.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, logActionMock } = vi.hoisted(() => ({
  state: {
    cancellationRow: null as any,
    updates: [] as Array<{ table: string; patch: any; id: string }>,
    notes: [] as Array<{ column: string; id: string; body: string }>,
    failUpdate: null as string | null,
  },
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: state.cancellationRow, error: null }),
          maybeSingle: () => Promise.resolve({ data: { display_name: 'Huayi Gao' }, error: null }),
        }),
      }),
      update: (patch: any) => ({
        eq: (_c: string, id: string) => {
          if (state.failUpdate === table) {
            return Promise.resolve({ error: { message: 'row-level security' } });
          }
          state.updates.push({ table, patch, id });
          return Promise.resolve({ error: null });
        },
      }),
      insert: (row: any) => {
        const column = row.refund_id ? 'refund_id' : row.return_id ? 'return_id' : 'cancellation_id';
        state.notes.push({ column, id: row[column], body: row.body });
        return Promise.resolve({ error: null });
      },
    }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'huayi-1', email: 'huayi@virgohome.io' } } }),
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'huayi-1' } } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));
vi.mock('./templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve()) }));
vi.mock('./refundAutoCancel', () => ({ cancelOpenOrdersForRefund: vi.fn(() => Promise.resolve()) }));

import {
  cancelRefundRequest,
  cancelCancellationRequest,
  cancelReturnRequest,
  canCancelRefundRequest,
  canCancelReturnRequest,
  type OrderCancellation,
  type RefundStatus,
  type ReturnStatus,
} from './postShipment';

const cancellation = (over: Partial<OrderCancellation> = {}): OrderCancellation => ({
  id: 'c-1', order_ref: '#1261', customer_name: 'Support LILA',
  customer_email: 'support@virgohome.io', customer_phone: null, preferred_contact: null,
  order_date: '2026-09-17', product_name: null, order_amount_usd: 1299,
  purchase_channel: 'Shopify', reason: 'test order', description: null,
  product_received: false, desired_resolution: null, status: 'submitted',
  ops_notes: null, processed_by: null, processed_at: null, refund_approval_id: null,
  created_at: '2026-09-17T19:12:04Z', updated_at: '2026-09-17T19:12:04Z',
  ...over,
}) as OrderCancellation;

beforeEach(() => {
  state.cancellationRow = cancellation();
  state.updates = [];
  state.notes = [];
  state.failUpdate = null;
  logActionMock.mockClear();
});

describe('canCancelRefundRequest', () => {
  it('allows every column the case can still be sitting in', () => {
    for (const s of ['submitted', 'manager_review', 'finance_review', 'refund_queue'] as RefundStatus[]) {
      expect(canCancelRefundRequest(s)).toBe(true);
    }
  });

  it('refuses a case that is already finished', () => {
    // The money is gone, or the decision is made and recorded. Cancelling
    // would erase a payout from the board rather than an unwanted card.
    for (const s of ['refunded', 'denied', 'closed'] as RefundStatus[]) {
      expect(canCancelRefundRequest(s)).toBe(false);
    }
  });
});

describe('cancelRefundRequest', () => {
  it('closes the card and keeps the reason with the case', async () => {
    await cancelRefundRequest('refund-1', '  Duplicate of #1207  ');

    expect(state.updates).toEqual([
      { table: 'refund_approvals', patch: { status: 'closed' }, id: 'refund-1' },
    ]);
    // 'closed' is deliberate: Denied is a refusal aimed at a customer, and a
    // test card parked there reads as one. Closed also drops out of the
    // shipping guard, so the order goes back to being shippable.
    expect(state.notes).toEqual([
      { column: 'refund_id', id: 'refund-1', body: 'Request cancelled: Duplicate of #1207' },
    ]);
    expect(logActionMock).toHaveBeenCalledWith(
      'refund_request_cancelled', 'refund-1', 'Duplicate of #1207',
    );
  });

  it('will not cancel without a reason', async () => {
    await expect(cancelRefundRequest('refund-1', '   ')).rejects.toThrow(/reason/i);
    expect(state.updates).toEqual([]);
  });

  it('says so plainly when the database refuses the change', async () => {
    // refund_approvals UPDATE is RLS-gated. Silently swallowing that would
    // leave the operator believing a live refund card was pulled.
    state.failUpdate = 'refund_approvals';
    await expect(cancelRefundRequest('refund-1', 'test card')).rejects.toThrow(/row-level security/);
    expect(state.notes).toEqual([]);
  });
});

describe('cancelCancellationRequest', () => {
  it('closes the request without a refund and records why', async () => {
    await cancelCancellationRequest(cancellation(), 'Pedrum test order — never charged');

    const patch = state.updates.find(u => u.table === 'order_cancellations')?.patch;
    expect(patch).toMatchObject({ status: 'completed', refund_approval_id: null });
    expect(patch.processed_by).toBe('huayi-1');
    expect(patch.ops_notes).toContain('Request cancelled: Pedrum test order — never charged');
    // Same words on the thread the card shows, so the next person reading the
    // Cancellations tab sees the reason without digging in the audit log.
    expect(state.notes).toEqual([
      { column: 'cancellation_id', id: 'c-1', body: 'Request cancelled: Pedrum test order — never charged' },
    ]);
    expect(logActionMock).toHaveBeenCalledWith(
      'cancellation_request_cancelled', '#1261', 'Pedrum test order — never charged',
    );
  });

  it('keeps any ops notes already on the row', async () => {
    state.cancellationRow = cancellation({ ops_notes: 'Customer called twice.' });
    await cancelCancellationRequest(state.cancellationRow, 'duplicate request');

    const patch = state.updates.find(u => u.table === 'order_cancellations')?.patch;
    expect(patch.ops_notes).toContain('Customer called twice.');
    expect(patch.ops_notes).toContain('Request cancelled: duplicate request');
  });

  it('will not cancel without a reason', async () => {
    await expect(cancelCancellationRequest(cancellation(), '')).rejects.toThrow(/reason/i);
    expect(state.updates).toEqual([]);
  });
});

describe('canCancelReturnRequest', () => {
  it('allows both Account-Manager columns a return can sit in', () => {
    // Return Form Submitted (intake) and Return & Inspection.
    const live: ReturnStatus[] = ['created', 'pickup_scheduled', 'picked_up', 'received', 'inspected', 'discarded'];
    for (const s of live) expect(canCancelReturnRequest(s)).toBe(true);
  });

  it('refuses a return whose case is already finished', () => {
    for (const s of ['refunded', 'denied', 'closed'] as ReturnStatus[]) {
      expect(canCancelReturnRequest(s)).toBe(false);
    }
  });
});

describe('cancelReturnRequest', () => {
  it('closes the return and keeps the reason on its thread', async () => {
    await cancelReturnRequest('ret-1', '  Test submission from the form  ');

    expect(state.updates).toEqual([
      { table: 'returns', patch: { status: 'closed' }, id: 'ret-1' },
    ]);
    // 'closed' is terminal for a return, so the card leaves both pre-refund
    // columns — the same exit a compiled case takes, without a refund card.
    expect(state.notes).toEqual([
      { column: 'return_id', id: 'ret-1', body: 'Request cancelled: Test submission from the form' },
    ]);
    // Tagged as a return entity, like every other return-side log line, so the
    // case's activity trail shows it rather than only the global log.
    expect(logActionMock).toHaveBeenCalledWith(
      'return_request_cancelled', 'ret-1', 'Test submission from the form',
      { entityType: 'return', entityId: 'ret-1' },
    );
  });

  it('will not cancel without a reason', async () => {
    await expect(cancelReturnRequest('ret-1', ' ')).rejects.toThrow(/reason/i);
    expect(state.updates).toEqual([]);
  });

  it('says so plainly when the database refuses the change', async () => {
    state.failUpdate = 'returns';
    await expect(cancelReturnRequest('ret-1', 'test row')).rejects.toThrow(/row-level security/);
    expect(state.notes).toEqual([]);
  });
});
