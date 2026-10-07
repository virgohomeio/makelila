// Compiling a case into the refund pipeline used to copy the RETURN's
// refund_amount_usd, which is null on most returns — so cards opened at $0.00
// and Finance re-keyed every figure off the PDF. The opening amount now comes
// from the customer's sales invoice, in CAD (invoices are issued in CAD).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, invoicesForEmailMock, state } = vi.hoisted(() => {
  const state: { inserted: any } = { inserted: null };
  const insertMock = vi.fn((row: any) => {
    state.inserted = row;
    return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ref-1' }, error: null }) }) };
  });
  return { insertMock, invoicesForEmailMock: vi.fn(), state };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({ insert: insertMock }),
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
