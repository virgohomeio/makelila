-- orders.currency: ISO currency code from Shopify (order.currency). Defaults to
-- USD for pre-existing rows; the next Shopify sync backfills the real code.
alter table public.orders
  add column if not exists currency text not null default 'USD';
