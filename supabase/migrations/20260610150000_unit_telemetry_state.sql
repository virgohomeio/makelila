-- Feature J6: Telemetry-driven ticket auto-create
-- Creates unit_telemetry_state (denormalized shadow of telemetry DB),
-- telemetry_autoticket_shadow (pre-production dry-run log),
-- telemetry_autoticket_config (singleton feature flag), and
-- the upsert_telemetry_state() helper called by the edge function.
--
-- Also adds customers.telemetry_autoticket_suppress and extends
-- service_tickets.source check to include 'telemetry_auto'.

-- ============================================================ unit_telemetry_state

create table if not exists public.unit_telemetry_state (
  unit_serial         text primary key references public.units(serial) on delete cascade,
  classified_state    text not null,
  state_held_since    timestamptz not null,
  last_seen_at        timestamptz not null,
  -- is_stale = true when last_seen_at is more than 1 hour old;
  -- set by sync-telemetry-state edge function.
  is_stale            boolean not null default false,
  updated_at          timestamptz not null default now()
);

alter table public.unit_telemetry_state enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'unit_telemetry_state'
      and policyname = 'internal_only'
  ) then
    execute $p$
      create policy internal_only on public.unit_telemetry_state
        using (public.is_internal_user())
    $p$;
  end if;
end $$;

create index if not exists idx_unit_telemetry_state_stale
  on public.unit_telemetry_state (is_stale)
  where is_stale = true;

-- ============================================================ telemetry_autoticket_shadow

create table if not exists public.telemetry_autoticket_shadow (
  id                  uuid primary key default gen_random_uuid(),
  unit_serial         text not null,
  customer_id         uuid,
  classified_state    text not null,
  state_held_since    timestamptz not null,
  would_create_at     timestamptz not null default now(),
  -- skipped_reason: why this row was not turned into a real ticket.
  -- e.g. 'existing_open_ticket', 'suppress_flag', 'NOT_MIXING_disabled'
  skipped_reason      text
);

alter table public.telemetry_autoticket_shadow enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'telemetry_autoticket_shadow'
      and policyname = 'internal_only'
  ) then
    execute $p$
      create policy internal_only on public.telemetry_autoticket_shadow
        using (public.is_internal_user())
    $p$;
  end if;
end $$;

create index if not exists idx_shadow_unit_serial
  on public.telemetry_autoticket_shadow (unit_serial);

create index if not exists idx_shadow_would_create_at
  on public.telemetry_autoticket_shadow (would_create_at desc);

-- ============================================================ telemetry_autoticket_config (singleton)

create table if not exists public.telemetry_autoticket_config (
  -- Singleton: exactly one row with id=1.
  id          int primary key default 1 check (id = 1),
  -- shadow_mode=true → writes go to telemetry_autoticket_shadow only (default for 2-week pilot).
  -- shadow_mode=false → writes go to real service_tickets.
  shadow_mode boolean not null default true,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- Seed the singleton row with shadow_mode=true so real writes never happen
-- until an operator explicitly flips the flag.
insert into public.telemetry_autoticket_config (id, shadow_mode, enabled)
values (1, true, true)
on conflict do nothing;

alter table public.telemetry_autoticket_config enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'telemetry_autoticket_config'
      and policyname = 'internal_only'
  ) then
    execute $p$
      create policy internal_only on public.telemetry_autoticket_config
        using (public.is_internal_user())
    $p$;
  end if;
end $$;

-- ============================================================ customers.telemetry_autoticket_suppress

alter table public.customers
  add column if not exists telemetry_autoticket_suppress boolean not null default false;

-- ============================================================ service_tickets source check (extend)

-- Extend to include 'telemetry_auto'. Pattern mirrors 20260527210000.
alter table public.service_tickets drop constraint if exists service_tickets_source_check;
alter table public.service_tickets add constraint service_tickets_source_check
  check (source = any (array[
    'calendly','customer_form','hubspot','fulfillment_flag',
    'ops_manual','gmail','quo','google_calendar','telemetry_auto'
  ]));

-- ============================================================ upsert_telemetry_state() RPC helper

-- Called by the sync-telemetry-state edge function to atomically upsert
-- state without a SELECT-then-UPDATE race window.
--
-- State transition logic:
--   * If the unit is new → insert with state_held_since = p_machine_last_seen_at
--   * If state CHANGED   → reset state_held_since to p_machine_last_seen_at
--   * If state SAME      → keep existing state_held_since (preserve hold duration)
create or replace function public.upsert_telemetry_state(
  p_unit_serial          text,
  p_classified_state     text,
  p_machine_last_seen_at timestamptz
) returns void language sql as $$
  insert into public.unit_telemetry_state
    (unit_serial, classified_state, state_held_since, last_seen_at, is_stale, updated_at)
  values
    (p_unit_serial, p_classified_state, p_machine_last_seen_at, p_machine_last_seen_at, false, now())
  on conflict (unit_serial) do update set
    classified_state = case
                         when excluded.classified_state <> unit_telemetry_state.classified_state
                         then excluded.classified_state
                         else unit_telemetry_state.classified_state
                       end,
    state_held_since = case
                         when excluded.classified_state <> unit_telemetry_state.classified_state
                         then excluded.last_seen_at
                         else unit_telemetry_state.state_held_since
                       end,
    last_seen_at     = excluded.last_seen_at,
    is_stale         = false,
    updated_at       = now();
$$;
