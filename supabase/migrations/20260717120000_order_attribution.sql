-- Per-order acquisition source, captured from Shopify by sync-shopify-orders:
-- UTM on the landing URL wins, else the referrer host (google → organic,
-- facebook → social, …), else direct. Powers the Marketing → Report "Source"
-- column so each buyer shows their real channel (e.g. "google organic search")
-- instead of falling back to the customer's first-touch. Backfilled on the next
-- full Shopify sync via the sync's refreshPatch.

alter table public.orders
  add column if not exists attribution_source   text,
  add column if not exists attribution_medium   text,
  add column if not exists attribution_campaign text;
