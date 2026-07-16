-- Klaviyo email campaign performance (one row per campaign) for the Marketing →
-- Email tab. Populated by sync-klaviyo-campaigns from the Klaviyo Campaigns API +
-- campaign-values report. Account-level metrics — independent of per-customer
-- profile linking (that's the journey leg, a separate concern).

create table if not exists public.klaviyo_campaigns (
  campaign_id          text primary key,
  name                 text,
  status               text,
  channel              text,
  send_time            timestamptz,
  recipients           integer,
  delivered            integer,
  opens_unique         integer,
  open_rate            numeric(8,4),
  clicks_unique        integer,
  click_rate           numeric(8,4),
  conversions          integer,
  revenue              numeric(12,2),
  unsubscribes         integer,
  unsubscribe_rate     numeric(8,4),
  bounce_rate          numeric(8,4),
  spam_complaint_rate  numeric(8,4),
  raw                  jsonb,
  synced_at            timestamptz not null default now()
);

alter table public.klaviyo_campaigns enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='klaviyo_campaigns' and policyname='internal_only') then
    execute 'create policy internal_only on public.klaviyo_campaigns using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
