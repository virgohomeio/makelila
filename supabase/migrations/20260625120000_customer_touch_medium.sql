-- Capture utm_medium alongside source so attribution can split paid vs organic
-- per platform (Facebook Paid vs Facebook Organic, Google Paid vs Google
-- Organic, etc.). Source alone can't distinguish them. Populated by
-- sync-shopify-orders from the order's landing-site UTM; classified into a
-- canonical channel at read time (lib/marketing/journey.ts classifyChannel).

alter table public.customers
  add column if not exists first_touch_medium text,
  add column if not exists last_touch_medium  text;
