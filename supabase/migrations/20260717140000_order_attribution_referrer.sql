-- The specific referring URL from Shopify's customer journey (firstVisit
-- referrerUrl) — e.g. https://linktr.ee/…, https://l.instagram.com/…, a blog.
-- Lets the Report show "Referral via linktr.ee" instead of a bare "Referral",
-- and lets the sync classify the source more precisely (Linktree, Instagram, …).

alter table public.orders
  add column if not exists attribution_referrer text;
