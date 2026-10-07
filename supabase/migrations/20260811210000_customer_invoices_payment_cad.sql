-- Refund cards default to what the customer actually PAID, which on a
-- QuickBooks sales invoice is the "Payment" line — not "Total Due", which
-- reads $0.00 once the payment has been applied. total_cad was extracted from
-- the amount-due wording, so 53 of 259 invoices carry 0.00 and every refund
-- card compiled from them started at $0.00.
--
-- payment_cad holds the "Payment" figure. Existing rows stay null until the
-- operator runs "Re-read amounts" in the Upload module, which re-extracts
-- from the stored PDFs; readers fall back to total_cad meanwhile.
-- (Applied to prod via MCP.)

alter table public.customer_invoices
  add column if not exists payment_cad numeric;

-- Stamped whenever the PDF has been read for its Payment figure, INCLUDING
-- when the invoice turns out not to have one. Without it, "re-read the rows
-- with no payment_cad" would hand the same unpaid invoices back on every pass
-- and the backfill would never move past them.
alter table public.customer_invoices
  add column if not exists payment_extracted_at timestamptz;

comment on column public.customer_invoices.payment_cad is
  'Amount on the invoice''s "Payment" line (CAD) — what the customer actually paid. Preferred over total_cad when defaulting a refund amount.';
comment on column public.customer_invoices.payment_extracted_at is
  'When the PDF was last read for payment_cad. Null = never read; set even when the invoice shows no payment, so the backfill terminates.';
