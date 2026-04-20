-- placed_at: when the customer placed the order (Shopify's order.created_at).
-- Nullable because historical rows may not have a distinct placed time; back-fill from created_at.
alter table public.orders
  add column if not exists placed_at timestamptz;

update public.orders
   set placed_at = created_at
 where placed_at is null;
