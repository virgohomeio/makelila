-- Shipping invoices: record the freight the CUSTOMER paid on a shipment
-- (e.g. shipping they were charged or paid the carrier directly), alongside
-- the freight WE paid. Recorded for reference only — it does not change the
-- Shipping bucket or margin on Profitability.
--
-- Idempotent: safe to hand-apply in the SQL editor and to re-run.

alter table public.customer_shipping_invoices
  add column if not exists freight_customer_paid_amount numeric(10,2) not null default 0
    check (freight_customer_paid_amount >= 0);
