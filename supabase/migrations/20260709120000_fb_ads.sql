-- Ad-level Meta metrics (one row per ad, lifetime) for per-ad-set + per-creative
-- analysis — e.g. the LILA Mini test where 5 creatives each run in 5 ad sets
-- (audiences). Compiled in the UI: overall, by adset_name, by ad_name (creative).

create table if not exists public.fb_ads (
  ad_id         text not null,
  ad_name       text,
  adset_id      text,
  adset_name    text,
  campaign_id   text,
  campaign_name text,
  date_start    date not null,
  date_stop     date,
  spend_cad     numeric(12,2),
  impressions   integer,
  clicks        integer,
  ctr           numeric(8,4),
  leads         integer,
  synced_at     timestamptz not null default now(),
  primary key (ad_id, date_start)
);
create index if not exists idx_fb_ads_campaign on public.fb_ads (campaign_id);

alter table public.fb_ads enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='fb_ads' and policyname='internal_only') then
    execute 'create policy internal_only on public.fb_ads using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
