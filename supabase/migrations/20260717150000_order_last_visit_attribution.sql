-- The purchase (converting) visit source, from Shopify's customer journey
-- lastVisit — distinct from the firstVisit acquisition source already stored in
-- attribution_source. Lets the Report show both "where they first came from" and
-- "where they came from when they bought" (Linktree, Meta ad, social, …).

alter table public.orders
  add column if not exists attribution_last_source   text,
  add column if not exists attribution_last_medium   text,
  add column if not exists attribution_last_referrer text;
