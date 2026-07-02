-- Dedup key for externally-sourced customer_events (Klaviyo email events, and
-- future Shopify/GA events). The Klaviyo event id goes here so re-running the
-- pull upserts instead of duplicating. NULLs are distinct in a Postgres unique
-- index, so existing lovely rows (external_id NULL) are unaffected and can stay
-- NULL indefinitely.

alter table public.customer_events
  add column if not exists external_id text;

create unique index if not exists idx_customer_events_external
  on public.customer_events (external_id);
