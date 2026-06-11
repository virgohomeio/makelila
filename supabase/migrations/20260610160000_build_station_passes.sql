-- J7: build_station_passes event-row QC table.
-- Each pass/fail at a QC station is an immutable row. The trigger below
-- maintains the denormalized qc_check columns on units (latest attempt wins).

-- ============================================================ table
create table if not exists public.build_station_passes (
  id               uuid primary key default gen_random_uuid(),
  unit_serial      text not null references public.units(serial) on delete cascade,
  station          text not null check (station in ('electrical', 'mechanical', 'firmware_flash', 'final_qa')),
  pass_status      text not null check (pass_status in ('pass', 'fail', 'incomplete', 'rework')),
  attempt_seq      int not null,
  defect_category  text check (defect_category in (
    'solder_issue', 'loose_connection', 'firmware_flash_failed',
    'display_issue', 'motor_issue', 'sensor_issue', 'mechanical_alignment', 'other'
  )),
  defect_notes     text,
  technician_id    uuid references auth.users(id),
  firmware_version text,
  photo_urls       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

alter table public.build_station_passes
  add constraint if not exists build_station_passes_unit_station_attempt_unique
  unique (unit_serial, station, attempt_seq);

-- ============================================================ indexes
create index if not exists idx_station_passes_serial
  on public.build_station_passes(unit_serial);
create index if not exists idx_station_passes_station_status
  on public.build_station_passes(station, pass_status);
create index if not exists idx_station_passes_technician_date
  on public.build_station_passes(technician_id, created_at desc);

-- ============================================================ RLS
alter table public.build_station_passes enable row level security;

create policy "station_passes_select" on public.build_station_passes
  for select to authenticated
  using (public.is_internal_user());

create policy "station_passes_insert" on public.build_station_passes
  for insert to authenticated
  with check (public.is_internal_user());

-- No UPDATE policy: passes are immutable. Enforce with a trigger too.

-- ============================================================ immutability trigger
create or replace function public.deny_station_pass_update() returns trigger language plpgsql as $$
begin
  raise exception 'build_station_passes rows are immutable — log a new pass instead';
end $$;

drop trigger if exists station_pass_immutable on public.build_station_passes;
create trigger station_pass_immutable
  before update on public.build_station_passes
  for each row execute function public.deny_station_pass_update();

-- ============================================================ sync trigger
-- Maintains denormalized units columns from the latest attempt per station.
-- 'rework' is NOT in the qc_check enum, so we skip the cast for that value.
create or replace function public.sync_unit_from_station_pass() returns trigger language plpgsql as $$
begin
  -- Only update units if this is the latest attempt for this station
  if new.attempt_seq = (
    select max(attempt_seq) from public.build_station_passes
    where unit_serial = new.unit_serial and station = new.station
  ) then
    if new.station in ('electrical', 'mechanical') then
      if new.pass_status <> 'rework' then
        update public.units set
          electrical_check = case
            when new.station = 'electrical' then new.pass_status::public.qc_check
            else electrical_check
          end,
          mechanical_check = case
            when new.station = 'mechanical' then new.pass_status::public.qc_check
            else mechanical_check
          end
        where serial = new.unit_serial;
      end if;
    elsif new.station = 'firmware_flash' and new.pass_status = 'pass' then
      update public.units set firmware_version = new.firmware_version
      where serial = new.unit_serial and new.firmware_version is not null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists station_pass_sync on public.build_station_passes;
create trigger station_pass_sync
  after insert on public.build_station_passes
  for each row execute function public.sync_unit_from_station_pass();

-- ============================================================ realtime
-- Wrapped in DO block to make it idempotent (re-running migration won't fail if
-- the table is already in the publication).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'build_station_passes'
  ) then
    alter publication supabase_realtime add table public.build_station_passes;
  end if;
end $$;

-- ============================================================ DELETE protection
-- build_station_passes rows are permanent events. There is intentionally no
-- DELETE RLS policy; the trigger below enforces immutability at the DB level.
create or replace function public.deny_station_pass_delete() returns trigger language plpgsql as $$
begin
  raise exception 'build_station_passes rows are permanent — they cannot be deleted';
  return null;
end $$;

drop trigger if exists station_pass_no_delete on public.build_station_passes;
create trigger station_pass_no_delete
  before delete on public.build_station_passes
  for each row execute function public.deny_station_pass_delete();
