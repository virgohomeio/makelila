-- Journey Report "Sale Source": which Shopify sales channel an order transacted
-- through, as a friendly label. Populated by sync-shopify-orders from Shopify's
-- REST source_name:
--   'web' / empty         -> 'Our Website'   (our own storefront)
--   'pos'                 -> 'Point of Sale'
--   'shopify_draft_order' -> 'Manual / Draft'
--   Mirakl / Walmart / Best Buy / Shopify Collective connectors -> their marketplace
-- NULL means an order synced before this column existed; the report reads NULL
-- as 'Our Website' (the storefront has always been the default channel). Idempotent
-- so it is a no-op where it has already been applied to a remote environment.
alter table public.orders add column if not exists sales_channel text;

comment on column public.orders.sales_channel is
  'Friendly Shopify sales-channel label (Our Website / Walmart / Best Buy / Shopify Collective / …), set by sync-shopify-orders from REST source_name. NULL = pre-column order, read as Our Website.';
