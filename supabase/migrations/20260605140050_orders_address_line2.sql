-- Capture the second address line (apartment / unit / suite number) from
-- Shopify so Order Review can surface "Apartment/Unit #" for customers who
-- provided one. Shopify stores this in shipping_address.address2; we never
-- mapped it before, so apartment numbers were silently dropped on sync.
--
-- Nullable: most house deliveries won't have one, and the UI only shows the
-- row when a value is present.

alter table public.orders
  add column if not exists address_line2 text;
