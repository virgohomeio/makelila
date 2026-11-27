-- utm_content per order (from Shopify's landing-URL / customer-journey UTM).
-- For Meta ads this carries the exact ad creative (e.g. "Fall 2026 v1 - v28a"),
-- which the Journey Report turns into a deterministic per-order "Saw Meta Ad
-- v28a" — far better than the best-effort clean-day match. Backfilled for
-- existing orders on the next full Shopify sync (Sync All).
alter table public.orders add column if not exists attribution_content text;
