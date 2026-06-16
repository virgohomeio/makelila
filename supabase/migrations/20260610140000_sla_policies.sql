-- J5: SLA policy table + seed
-- Stores per-priority first_response and resolution SLA targets.
-- Cron breach logic reads from this table every 15 minutes.

create table if not exists public.sla_policies (
  id                    uuid primary key default gen_random_uuid(),
  priority              text not null check (priority in ('p1', 'p2', 'p3')),
  first_response_minutes int not null,
  resolution_minutes    int not null,
  escalate_to_user_id   uuid references auth.users(id),
  is_active             boolean default true,
  created_at            timestamptz default now()
);

-- Unique active policy per priority so triggers can do a simple lookup.
create unique index if not exists sla_policies_active_priority
  on public.sla_policies (priority)
  where is_active = true;

-- RLS: internal users only (mirrors is_internal_user() from 20260604200000)
alter table public.sla_policies enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename   = 'sla_policies'
      and policyname  = 'sla_policies_select'
  ) then
    create policy "sla_policies_select" on public.sla_policies
      for select to authenticated
      using (public.is_internal_user());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename   = 'sla_policies'
      and policyname  = 'sla_policies_insert'
  ) then
    create policy "sla_policies_insert" on public.sla_policies
      for insert to authenticated
      with check (public.is_internal_user());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename   = 'sla_policies'
      and policyname  = 'sla_policies_update'
  ) then
    create policy "sla_policies_update" on public.sla_policies
      for update to authenticated
      using (public.is_internal_user()) with check (public.is_internal_user());
  end if;
end $$;

-- Seed: P1 = 1h response / 24h resolution
--       P2 = 4h response / 72h resolution
--       P3 = 24h response / 7d resolution
-- escalate_to_user_id: look up George; wrap in DO so a missing user (branch DB)
-- doesn't fail the migration.
do $$
declare
  george_id uuid;
begin
  select id into george_id
    from auth.users
    where email = 'george@virgohome.io'
    limit 1;

  insert into public.sla_policies (priority, first_response_minutes, resolution_minutes, escalate_to_user_id)
  values
    ('p1', 60,   1440,  george_id),
    ('p2', 240,  4320,  george_id),
    ('p3', 1440, 10080, george_id)
  on conflict do nothing;
end $$;
