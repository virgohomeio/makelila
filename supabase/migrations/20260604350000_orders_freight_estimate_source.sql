-- Backlog #17 — track where the freight_estimate came from. Today the
-- number on FreightCard is opaque: it could be the Shopify shipping_lines
-- value (default sync), an operator's manual edit with a ClickShip quote,
-- or eventually a Freightcom API pull (#19). Adding a small source tag
-- lets the operator see which path produced the current value.

alter table public.orders
  add column if not exists freight_estimate_source text not null default 'shopify';

-- Existing rows: stamp 'shopify' since that's what sync-shopify-orders
-- has been doing (column default handles the same).
