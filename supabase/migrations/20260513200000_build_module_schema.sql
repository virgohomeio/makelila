-- Build module schema: 5 new tables for the China→CA production pipeline.
-- Pipeline stages: PO → Production → Freight → IQC → Rework → Burn-in → Ready.
-- Per-batch upstream (factory_orders, freight_shipments); per-unit downstream
-- (build_defects, burn_in_tests). Replaces the Notion Master Issue Log and
-- supersedes unit_reworks (kept read-only for historical reference).

-- ============================================================ factory_orders
create table if not exists public.factory_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text unique not null,
  batch         text not null,
  qty_ordered   int  not null check (qty_ordered > 0),
  unit_cost_usd numeric(10,2),
  manufacturer  text not null default 'Benliang',
  ship_target_date date,
  status text not null default 'placed'
    check (status in ('placed','in_production','ready_to_ship','shipped','cancelled')),
  notes text,
  placed_at timestamptz not null default now(),
  placed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_factory_orders_batch on public.factory_orders(batch);
create index if not exists idx_factory_orders_status on public.factory_orders(status);
alter table public.factory_orders enable row level security;
create policy "factory_orders_select" on public.factory_orders for select to authenticated using (true);
create policy "factory_orders_insert" on public.factory_orders for insert to authenticated with check (true);
create policy "factory_orders_update" on public.factory_orders for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.factory_orders;

create or replace function public.touch_factory_orders_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists factory_orders_touch on public.factory_orders;
create trigger factory_orders_touch before update on public.factory_orders
  for each row execute function public.touch_factory_orders_updated_at();

-- ============================================================ freight_shipments
create table if not exists public.freight_shipments (
  id              uuid primary key default gen_random_uuid(),
  po_id           uuid not null references public.factory_orders(id) on delete cascade,
  carrier         text,
  container_no    text,
  bill_of_lading  text,
  etd_china       date,
  etd_actual      date,
  eta_canada      date,
  eta_actual      date,
  customs_cleared_at timestamptz,
  arrived_at_warehouse_at timestamptz,
  status text not null default 'booked'
    check (status in ('booked','on_boat','in_customs','in_transit','arrived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_freight_po on public.freight_shipments(po_id);
create index if not exists idx_freight_status on public.freight_shipments(status);
alter table public.freight_shipments enable row level security;
create policy "freight_select" on public.freight_shipments for select to authenticated using (true);
create policy "freight_insert" on public.freight_shipments for insert to authenticated with check (true);
create policy "freight_update" on public.freight_shipments for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.freight_shipments;

create or replace function public.touch_freight_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists freight_touch on public.freight_shipments;
create trigger freight_touch before update on public.freight_shipments
  for each row execute function public.touch_freight_updated_at();

-- ============================================================ build_defects
create table if not exists public.build_defects (
  id           uuid primary key default gen_random_uuid(),
  unit_serial  text not null references public.units(serial) on delete cascade,
  category     text not null check (category in (
    'electrical','mechanical','aesthetic','firmware','assembly','packaging',
    'legacy_rework','legacy_iqc_notion','other'
  )),
  subject      text not null,
  description  text,
  severity     text not null default 'medium'
    check (severity in ('critical','high','medium','low')),
  status       text not null default 'open'
    check (status in ('open','in_rework','resolved','accepted_with_note','scrapped')),
  found_by         uuid references auth.users(id),
  found_by_name    text,
  resolved_by      uuid references auth.users(id),
  resolved_by_name text,
  resolution_note  text,
  source_notion_url text,
  found_at     timestamptz not null default now(),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_defects_serial on public.build_defects(unit_serial);
create index if not exists idx_defects_status on public.build_defects(status)
  where status in ('open','in_rework');
create index if not exists idx_defects_severity on public.build_defects(severity)
  where status in ('open','in_rework');
alter table public.build_defects enable row level security;
create policy "defects_select" on public.build_defects for select to authenticated using (true);
create policy "defects_insert" on public.build_defects for insert to authenticated with check (true);
create policy "defects_update" on public.build_defects for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.build_defects;

create or replace function public.touch_defects_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists defects_touch on public.build_defects;
create trigger defects_touch before update on public.build_defects
  for each row execute function public.touch_defects_updated_at();

-- ============================================================ build_attachments
create table if not exists public.build_attachments (
  id          uuid primary key default gen_random_uuid(),
  defect_id   uuid not null references public.build_defects(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  mime_type   text not null,
  size_bytes  bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id)
);
create index if not exists idx_attachments_defect on public.build_attachments(defect_id);
alter table public.build_attachments enable row level security;
create policy "attachments_select" on public.build_attachments for select to authenticated using (true);
create policy "attachments_insert" on public.build_attachments for insert to authenticated with check (true);
alter publication supabase_realtime add table public.build_attachments;

-- ============================================================ burn_in_tests
create table if not exists public.burn_in_tests (
  id           uuid primary key default gen_random_uuid(),
  unit_serial  text not null references public.units(serial) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  duration_target_hours int not null default 24,
  result       text check (result in ('pass','fail','aborted')),
  failure_mode text,
  notes        text,
  operator_email text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_burnin_serial on public.burn_in_tests(unit_serial);
alter table public.burn_in_tests enable row level security;
create policy "burnin_select" on public.burn_in_tests for select to authenticated using (true);
create policy "burnin_insert" on public.burn_in_tests for insert to authenticated with check (true);
create policy "burnin_update" on public.burn_in_tests for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.burn_in_tests;

-- ============================================================ TRIGGERS

-- T3: defect inserted with status='in_rework' → unit goes to 'rework'
create or replace function public.defect_promote_unit_rework() returns trigger language plpgsql as $$
begin
  if new.status = 'in_rework' then
    update public.units set status = 'rework' where serial = new.unit_serial;
  end if;
  return new;
end $$;
drop trigger if exists defect_promote_rework on public.build_defects;
create trigger defect_promote_rework after insert on public.build_defects
  for each row execute function public.defect_promote_unit_rework();

-- T4: defect status flipped to 'resolved' (and no other open/in_rework defects
-- remain for this unit) → unit goes back to 'ca-test' for re-inspection
create or replace function public.defect_resolved_check() returns trigger language plpgsql as $$
declare
  open_count int;
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    select count(*) into open_count
      from public.build_defects
      where unit_serial = new.unit_serial
        and status in ('open','in_rework');
    if open_count = 0 then
      update public.units set status = 'ca-test'
        where serial = new.unit_serial
          and status = 'rework';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists defect_resolved on public.build_defects;
create trigger defect_resolved after update on public.build_defects
  for each row execute function public.defect_resolved_check();

-- T5: burn-in test result='pass' → unit goes to 'ready'
create or replace function public.burnin_pass_promote() returns trigger language plpgsql as $$
begin
  if new.result = 'pass' and (old.result is null or old.result is distinct from 'pass') then
    update public.units set status = 'ready' where serial = new.unit_serial;
  end if;
  return new;
end $$;
drop trigger if exists burnin_pass on public.burn_in_tests;
create trigger burnin_pass after update on public.burn_in_tests
  for each row execute function public.burnin_pass_promote();

-- T6: burn-in test result='fail' → auto-create a build_defects row
-- (Trigger T3 then bumps the unit to status='rework' as a downstream effect.)
create or replace function public.burnin_fail_create_defect() returns trigger language plpgsql as $$
begin
  if new.result = 'fail' and (old.result is null or old.result is distinct from 'fail') then
    insert into public.build_defects (
      unit_serial, category, subject, description, severity, status, found_by_name
    ) values (
      new.unit_serial,
      'electrical',
      'Burn-in failure',
      coalesce(new.failure_mode, 'No failure mode provided'),
      'high',
      'in_rework',
      coalesce(new.operator_email, 'burn-in system')
    );
  end if;
  return new;
end $$;
drop trigger if exists burnin_fail on public.burn_in_tests;
create trigger burnin_fail after update on public.burn_in_tests
  for each row execute function public.burnin_fail_create_defect();
