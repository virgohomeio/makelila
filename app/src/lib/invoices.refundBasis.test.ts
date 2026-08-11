// A refund is based on what the customer PAID — the invoice's "Payment" line.
// total_cad was extracted from the amount-due wording, so on any already-paid
// invoice it reads 0.00; 53 of 259 invoices on file are 0.00 for that reason,
// and every refund card compiled from one opened at $0.00.
import { describe, it, expect } from 'vitest';
import { invoiceAmountCad, pickRefundBasisInvoice, type CustomerInvoice } from './invoices';

const inv = (over: Partial<CustomerInvoice>): CustomerInvoice => ({
  id: 'i1', customer_id: 'c1', order_id: null, order_ref: null,
  invoice_number: '1000', document_type: 'invoice', file_name: 'i.pdf',
  storage_path: 'inbound/i.pdf', invoice_date: '2026-01-01',
  total_cad: null, payment_cad: null, payment_extracted_at: null, bill_to_name: null,
  match_status: 'matched', match_method: null, notes: null,
  uploaded_by: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('invoiceAmountCad', () => {
  it('prefers what was paid over the invoice total', () => {
    expect(invoiceAmountCad(inv({ payment_cad: 1049, total_cad: 1200 }))).toBe(1049);
  });

  it('ignores the $0.00 that a paid invoice shows as its due amount', () => {
    expect(invoiceAmountCad(inv({ payment_cad: 1049, total_cad: 0 }))).toBe(1049);
    expect(invoiceAmountCad(inv({ payment_cad: null, total_cad: 0 }))).toBeNull();
  });

  it('falls back to the total for invoices not yet re-read', () => {
    expect(invoiceAmountCad(inv({ payment_cad: null, total_cad: 899.5 }))).toBe(899.5);
  });
});

describe('pickRefundBasisInvoice', () => {
  it('prefers the invoice for the order being returned', () => {
    const picked = pickRefundBasisInvoice([
      inv({ id: 'a', order_ref: '#1012', payment_cad: 500, invoice_date: '2025-01-02' }),
      inv({ id: 'b', order_ref: '#2222', payment_cad: 900, invoice_date: '2026-05-05' }),
    ], '1012');
    expect(picked?.id).toBe('a'); // order match beats recency
  });

  it('falls back to the newest sales invoice with an amount', () => {
    const picked = pickRefundBasisInvoice([
      inv({ id: 'old', payment_cad: 500, invoice_date: '2024-01-01' }),
      inv({ id: 'new', payment_cad: 900, invoice_date: '2026-05-05' }),
    ], null);
    expect(picked?.id).toBe('new');
  });

  it('never prices a refund off a previous refund receipt', () => {
    const picked = pickRefundBasisInvoice([
      inv({ id: 'credit', document_type: 'refund_receipt', payment_cad: 900, invoice_date: '2026-06-06' }),
      inv({ id: 'sale', payment_cad: 1049, invoice_date: '2026-01-01' }),
    ], null);
    expect(picked?.id).toBe('sale');
  });

  it('returns null when nothing carries a usable amount', () => {
    expect(pickRefundBasisInvoice([inv({ total_cad: 0 }), inv({ total_cad: null })], null)).toBeNull();
    expect(pickRefundBasisInvoice([], '1012')).toBeNull();
  });
});
