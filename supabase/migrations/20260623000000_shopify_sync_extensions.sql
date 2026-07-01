alter table public.orders
  add column if not exists tax_lines          jsonb,
  add column if not exists shipping_line_title text;

alter table public.customers
  add column if not exists shopify_id text;

create unique index if not exists customers_shopify_id_idx
  on public.customers(shopify_id)
  where shopify_id is not null;
