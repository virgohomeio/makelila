-- Meta purchase conversions broken down by age × gender × country × day (per
-- campaign), used by the Journey Report to auto-fill a buyer's Age/Gender when a
-- sale maps to exactly one clean segment (the operator's manual toggle method,
-- automated). Only rows with a purchase are stored. LILA Mini campaigns are
-- excluded at sync time (they convert on Shopline, not Shopify).

create table if not exists public.fb_demographics (
  campaign_id text not null,
  date        date not null,
  age         text not null,
  gender      text not null,
  country     text not null,
  purchases   integer,
  synced_at   timestamptz not null default now(),
  primary key (campaign_id, date, age, gender, country)
);

alter table public.fb_demographics enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='fb_demographics' and policyname='internal_only') then
    execute 'create policy internal_only on public.fb_demographics using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
