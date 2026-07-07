-- Rich Ads-Manager metrics for the Campaigns tab. reach as a column (used in
-- aggregations); the full column set (adds-to-cart, video plays, post
-- engagement, budget, bid strategy, dates, cpm, etc.) lives in `metrics` jsonb.
-- raw jsonb keeps the full Meta insights row for forensics.

alter table public.fb_campaigns
  add column if not exists reach   integer,
  add column if not exists metrics jsonb not null default '{}'::jsonb,
  add column if not exists raw     jsonb;
