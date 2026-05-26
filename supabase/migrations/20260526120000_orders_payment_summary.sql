-- Alpha-feedback P1 #4: Shopify payment summary fields on orders.
-- All nullable; backfilled by the next sync-shopify-orders run.

alter table public.orders
  add column if not exists subtotal_usd       numeric(10,2),
  add column if not exists tax_usd            numeric(10,2),
  add column if not exists discount_total_usd numeric(10,2),
  add column if not exists discount_codes     text[],
  add column if not exists payment_methods    text[],
  add column if not exists financial_status   text;
