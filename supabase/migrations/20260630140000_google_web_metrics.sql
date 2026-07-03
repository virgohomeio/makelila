-- Google web analytics: GA4 daily traffic (by default channel group) + Search
-- Console daily performance. Feed the Marketing → Web tab. Populated by the
-- sync-ga4 / sync-search-console edge functions.

create table if not exists public.ga4_daily (
  date        date not null,
  channel     text not null,
  sessions    integer not null default 0,
  users       integer not null default 0,
  conversions numeric(12,2) not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (date, channel)
);
create index if not exists idx_ga4_daily_date on public.ga4_daily (date desc);

create table if not exists public.gsc_daily (
  date        date primary key,
  clicks      integer not null default 0,
  impressions integer not null default 0,
  ctr         numeric(6,4),
  position    numeric(6,2),
  synced_at   timestamptz not null default now()
);
create index if not exists idx_gsc_daily_date on public.gsc_daily (date desc);

alter table public.ga4_daily enable row level security;
alter table public.gsc_daily enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ga4_daily' and policyname='internal_only') then
    execute 'create policy internal_only on public.ga4_daily using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='gsc_daily' and policyname='internal_only') then
    execute 'create policy internal_only on public.gsc_daily using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
