-- Google Ads campaign metrics, parallel to fb_campaigns — one row per campaign
-- per day so the Journey Report / CAC table can window spend by sale period the
-- same way it does for Meta. Populated by the sync-google-ads edge function.
--
-- Spend is stored in the Google Ads account's own currency (`currency`), like
-- fb_campaigns' spend. Google reports cost in micros; the sync divides by 1e6.
create table if not exists public.google_ads_campaigns (
  campaign_id       text not null,
  campaign_name     text,
  status            text,
  date              date not null,
  spend             numeric,          -- account currency (see `currency`)
  currency          text,
  impressions       bigint,
  clicks            bigint,
  conversions       numeric,          -- Google "conversions" (e.g. purchases)
  conversions_value numeric,          -- revenue attributed by Google
  metrics           jsonb,            -- raw row for anything not promoted to a column
  synced_at         timestamptz not null default now(),
  primary key (campaign_id, date)
);

-- Read-only to internal users (same posture as the other marketing tables).
alter table public.google_ads_campaigns enable row level security;

drop policy if exists google_ads_campaigns_read on public.google_ads_campaigns;
create policy google_ads_campaigns_read on public.google_ads_campaigns
  for select to authenticated using (is_internal_user());

create index if not exists google_ads_campaigns_date_idx on public.google_ads_campaigns (date);
