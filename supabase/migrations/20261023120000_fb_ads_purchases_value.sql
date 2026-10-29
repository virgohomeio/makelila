-- Per-ad daily purchase VALUE (Meta's reported conversion value), alongside the
-- existing `purchases` count. Lets the Journey Report compute Meta ROAS for a
-- date range from the daily fb_ads rows (value / spend), mirroring how Google
-- ROAS uses google_ads_campaigns.conversions_value. The campaign-level value
-- rides along in fb_campaigns.metrics->>'website_purchases_value' (jsonb, no
-- column needed). Populated by the sync-facebook-ads edge function.
alter table public.fb_ads add column if not exists purchases_value numeric;
