// Compiling a case into the refund pipeline used to copy the RETURN's
// refund_amount_usd, which is null on most returns — so cards opened at $0.00
// and Finance re-keyed every figure off the PDF. The opening amount now comes
// from the customer's sales invoice, in CAD (invoices are issued in CAD).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, updateMock, invoicesForEmailMock, state } = vi.hoisted(() => {
  const state: { inserted: any; updates: { table: string; patch: any }[]; calls: string[] } = { inserted: null, updates: [], calls: [] };
  const insertMock = vi.fn((row: any) => {
    state.inserted = row;
    state.calls.push('insert');
    return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ref-1' }, error: null }) }) };
  });
  const updateMock = vi.fn((table: string, patch: any) => {
    state.updates.push({ table, patch });
    state.calls.push(`update:${table}`);
    return { eq: () => Promise.resolve({ error: null }) };
  });
  return { insertMock, updateMock, invoicesForEmailMock: vi.fn(), state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: insertMock,
      update: (patch: any) => updateMock(table, patch),
      // updateReturnStatus probes received_at before stamping it
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u-1' } } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1' } } }),
    },
  },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));
vi.mock('./templates', () => ({ sendTemplate: vi.fn(() => Promise.resolve()) }));
vi.mock('./invoices', async (orig) => ({
  ...(await orig<typeof import('./invoices')>()),
  invoicesForCustomerEmail: invoicesForEmailMock,
}));

import { compileReturnToRefund, defaultRefundAmountFromInvoice } from './postShipment';
import type { CustomerInvoice } from './invoices';
import type { ReturnRow } from './postShipment';

const invoice = (over: Partial<CustomerInvoice> = {}): CustomerInvoice => ({
  id: 'i1', customer_id: 'c1', order_id: null, order_ref: '#1012',
  invoice_number: '1219', document_type: 'invoice', file_name: 'i.pdf',
  storage_path: 'inbound/i.pdf', invoice_date: '2025-01-02',
  total_cad: 0, payment_cad: 1049, payment_extracted_at: '2026-08-11T00:00:00Z',
  bill_to_name: 'Chad Lockhart',
  match_status: 'matched', match_method: null, notes: null,
  uploaded_by: null, created_at: '2025-01-02T00:00:00Z',
  ...over,
});

const ret = (over: Partial<ReturnRow> = {}): ReturnRow => ({
  id: 'ret-1', customer_name: 'Chad Lockhart', customer_email: 'chad@example.com',
  original_order_ref: '#1012', refund_amount_usd: null, status: 'received',
  ...over,
} as ReturnRow);

describe('opening refund amount', () => {
  beforeEach(() => { state.inserted = null; insertMock.mockClear(); invoicesForEmailMock.mockReset(); });

  it('opens a compiled card at what the customer paid, in CAD', async () => {
    invoicesForEmailMock.mockResolvedValue([invoice()]);
    await compileReturnToRefund(ret());
    expect(state.inserted.refund_amount_usd).toBe(1049);
    expect(state.inserted.currency).toBe('CAD');
  });

  it('does not fall back to the $0.00 total on a paid invoice', async () => {
    // payment_cad absent (invoice not re-read yet) and total_cad 0.00 → the
    // invoice tells us nothing, so we must not claim CAD 0.00 as the amount.
    invoicesForEmailMock.mockResolvedValue([invoice({ payment_cad: null, total_cad: 0 })]);
    const r = await defaultRefundAmountFromInvoice('chad@example.com', '#1012', 250);
    expect(r).toEqual({ amount: 250, currency: 'USD', invoice: null });
  });

  it('falls back to the return amount in USD when there is no invoice', async () => {
    invoicesForEmailMock.mockResolvedValue([]);
    await compileReturnToRefund(ret({ refund_amount_usd: 799.99 }));
    expect(state.inserted.refund_amount_usd).toBe(799.99);
    expect(state.inserted.currency).toBe('USD');
  });

  it('still compiles when the invoice lookup itself fails', async () => {
    invoicesForEmailMock.mockRejectedValue(new Error('network down'));
    await compileReturnToRefund(ret({ refund_amount_usd: 100 }));
    expect(state.inserted.refund_amount_usd).toBe(100);
  });

  it('prefers the purchaser email when the filer was not the buyer', async () => {
    invoicesForEmailMock.mockResolvedValue([invoice()]);
    await compileReturnToRefund(ret({
      is_purchaser: false, purchaser_email: 'buyer@example.com', purchaser_name: 'Sarah Lockhart',
    } as Partial<ReturnRow>));
    expect(invoicesForEmailMock).toHaveBeenCalledWith('buyer@example.com');
    expect(state.inserted.customer_name).toBe('Sarah Lockhart');
  });
});

// "Discard → Completeness" compiles a case straight from the intake column
// (status created/pickup_scheduled/picked_up) when the customer is throwing a
// defective unit away. It used to leave the return at 'created', so every later
// gate (Manager Review, Finance) rejected the card and it sat in Manager Review
// no matter how often George clicked Confirm (Janey Hsiao, 2026-11-06).
describe('compiling a discard case', () => {
  beforeEach(() => {
    state.inserted = null; state.updates = []; state.calls = [];
    insertMock.mockClear(); updateMock.mockClear();
    invoicesForEmailMock.mockReset(); invoicesForEmailMock.mockResolvedValue([]);
  });

  it('marks an intake-stage discard return as discarded before opening the card', async () => {
    await compileReturnToRefund(ret({ status: 'created', disposition: 'discard' } as Partial<ReturnRow>));
    const retUpdate = state.updates.find(u => u.table === 'returns');
    expect(retUpdate?.patch.status).toBe('discarded');
    expect(state.calls.indexOf('update:returns')).toBeLessThan(state.calls.indexOf('insert'));
  });

  it('leaves an already-received return alone', async () => {
    await compileReturnToRefund(ret({ status: 'received', disposition: 'discard' } as Partial<ReturnRow>));
    expect(state.updates.filter(u => u.table === 'returns')).toEqual([]);
  });

  it('does not touch a ship-back return', async () => {
    await compileReturnToRefund(ret({ status: 'received', disposition: 'ship_back' } as Partial<ReturnRow>));
    expect(state.updates.filter(u => u.table === 'returns')).toEqual([]);
  });
});
