-- Stock module: master inventory ledger.
--
-- batches: one row per production run. Cost/logistics metadata sourced from
-- the inventory snapshot HTML (invoice #, manufacturer, incoterm, unit cost,
-- arrival date, production phases).
--
-- units: one row per physical unit ever built. Serial is the stable key; the
-- status enum covers the full lifecycle — from in-production in China, through
-- inbound/ca-test/ready/reserved/rework, to shipped/team-test/scrap/lost.
--
-- Seeding at bottom populates 5 batches + 450 units (350 built + 100 P100X
-- projected) using sensible status defaults per batch:
--   P50  (60)   → scrap         (decommissioned)
--   P150 (150)  → shipped (100) + scrap (50) for the 35% defect rate
--   P50N (40)  → shipped (36) + team-test (4)
--   P100 (100) → ready          (currently on shelves, cross-refs shelf_slots)
--   P100X (100)→ in-production  (not yet arrived)

-- ================================================================
-- batches
-- ================================================================
create table if not exists public.batches (
  id text primary key,                            -- 'P50', 'P150', 'P50N', 'P100', 'P100X'
  version text,                                   -- 'v3.5', 'v3.6', 'v3.7'
  manufacturer text not null,                     -- 'Ningbo MBV Kangmei', 'Dongguan LC Technology'
  manufacturer_short text,                        -- 'MBV', 'LC'
  incoterm text,                                  -- 'FOB Ningbo', 'CNF Toronto'
  unit_cost_usd numeric(10,2),
  total_cost_usd numeric(12,2),
  unit_count int not null,
  invoice_no text,
  invoice_date date,
  arrived_at date,                                -- null if not yet arrived
  destination text,                               -- 'MicroArt, Markham' etc.
  notes text,
  -- Production phases, one object per phase for the Gantt chart:
  -- [{ phase: 'sourcing'|'assembly'|'shipping'|'arrived', start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', label: '...' }, ...]
  phases jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.batches enable row level security;
create policy "batches_select" on public.batches for select to authenticated using (true);
create policy "batches_update" on public.batches for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.batches;

-- ================================================================
-- units
-- ================================================================
create table if not exists public.units (
  serial text primary key,                        -- 'LL01-00000000251'
  batch text not null references public.batches(id) on delete restrict,
  status text not null check (status in (
    'in-production','inbound','ca-test',
    'ready','reserved','rework',
    'shipped','team-test','scrap','lost'
  )),
  tested boolean not null default false,
  location text,                                  -- 'Toronto warehouse', 'Vancouver office', customer city, etc.
  customer_name text,                             -- populated when shipped
  customer_order_ref text,                        -- Shopify order ref if known
  carrier text,
  tracking_num text,
  firmware_version text,                          -- OTA firmware (future Add-to-Inventory flow)
  notes text,
  status_updated_at timestamptz not null default now(),
  status_updated_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_units_batch on public.units (batch);
create index if not exists idx_units_status on public.units (status);

alter table public.units enable row level security;
create policy "units_select" on public.units for select to authenticated using (true);
create policy "units_update" on public.units for update to authenticated using (true) with check (true);
create policy "units_insert" on public.units for insert to authenticated with check (true);

alter publication supabase_realtime add table public.units;

-- ================================================================
-- Helper: keep status_updated_at fresh on status changes
-- ================================================================
create or replace function public.touch_unit_status() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.status_updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists units_touch_status on public.units;
create trigger units_touch_status
  before update on public.units
  for each row execute function public.touch_unit_status();

-- ================================================================
-- Seed batches
-- ================================================================
insert into public.batches (id, version, manufacturer, manufacturer_short, incoterm,
  unit_cost_usd, total_cost_usd, unit_count, invoice_no, invoice_date, arrived_at,
  destination, notes, phases) values
(
  'P50', 'v3.5', 'Ningbo MBV Kangmei Technology', 'MBV', 'FOB Ningbo',
  750.00, 45000.00, 60, 'PI240726B01', '2024-07-26', '2025-02-15',
  'Toronto warehouse',
  'First batch. 90-day lead time. Field testing from Mar 2025. Mostly decommissioned now.',
  '[
    {"phase":"sourcing","start":"2024-07-13","end":"2024-08-14","label":"Sourcing"},
    {"phase":"assembly","start":"2024-08-14","end":"2024-12-23","label":"Assembly & Mold"},
    {"phase":"shipping","start":"2025-01-01","end":"2025-02-15","label":"Sea Ningbo→Toronto"},
    {"phase":"arrived","start":"2025-02-15","end":"2025-03-31","label":"Field test CA"}
  ]'::jsonb
),
(
  'P150', 'v3.6', 'Ningbo MBV Kangmei Technology', 'MBV', 'FOB Ningbo',
  345.28, 51792.00, 150, 'PI250321B02', '2025-03-21', '2025-08-15',
  'Toronto warehouse',
  '2.5× volume over P50, 54% unit cost drop via MBV in-house sourcing. 5 units air-shipped Jul 19; 138 sea-shipped Jul 23. 35% defect rate observed. 49 delivered, 50 defective.',
  '[
    {"phase":"sourcing","start":"2025-03-01","end":"2025-04-16","label":"Sourcing"},
    {"phase":"assembly","start":"2025-04-21","end":"2025-07-18","label":"Assembly & QC"},
    {"phase":"shipping","start":"2025-07-23","end":"2025-08-15","label":"Sea + 5 Air"},
    {"phase":"arrived","start":"2025-08-15","end":"2025-09-30","label":"Arrived CA"}
  ]'::jsonb
),
(
  'P50N', 'v3.7', 'Dongguan LC Technology', 'LC', 'CNF Toronto',
  314.00, 13300.00, 40, 'CP20251024-Rev1', '2025-10-24', '2025-12-05',
  'Toronto warehouse',
  '40 LILA units + 40 replacement top lids for the P150 batch. Validation issues Dec 18 (rust, motor, odor, firmware).',
  '[
    {"phase":"sourcing","start":"2025-09-11","end":"2025-10-07","label":"Sourcing"},
    {"phase":"assembly","start":"2025-10-07","end":"2025-10-22","label":"CM Assembly"},
    {"phase":"shipping","start":"2025-11-01","end":"2025-12-05","label":"Sea + Rail"},
    {"phase":"arrived","start":"2025-12-05","end":"2025-12-18","label":"CA Test"}
  ]'::jsonb
),
(
  'P100', null, 'Dongguan LC Technology', 'LC', 'CNF Toronto',
  314.00, 31400.00, 100, 'CP20250126-Rev1', '2026-01-26', '2026-04-13',
  'MicroArt, Markham',
  'Container MSDU5858060. Customs via Elopa. 89% assembly pass rate.',
  '[
    {"phase":"sourcing","start":"2025-10-20","end":"2026-01-05","label":"Parts sourcing"},
    {"phase":"assembly","start":"2026-01-13","end":"2026-01-28","label":"Assembly"},
    {"phase":"shipping","start":"2026-02-06","end":"2026-04-13","label":"Sea shipping"},
    {"phase":"arrived","start":"2026-04-13","end":"2026-04-30","label":"Arrived CA"}
  ]'::jsonb
),
(
  'P100X', null, 'Dongguan LC Technology', 'LC', 'CNF Toronto',
  null, null, 100, null, '2026-03-25', null,
  'MicroArt, Markham (projected)',
  'Projected arrival Sep 2026. Order sent Mar 25 2026. 8 parts removed vs P100.',
  '[
    {"phase":"sourcing","start":"2026-03-25","end":"2026-06-15","label":"Sourcing (projected)"},
    {"phase":"assembly","start":"2026-06-15","end":"2026-07-01","label":"Assembly (projected)"},
    {"phase":"shipping","start":"2026-07-01","end":"2026-09-15","label":"Sea (projected)"},
    {"phase":"arrived","start":"2026-09-15","end":"2026-09-30","label":"Arrived (projected)"}
  ]'::jsonb
)
on conflict (id) do nothing;

-- ================================================================
-- Seed units (450 rows)
-- ================================================================
-- Serial layout (zero-padded 11-digit within LL01- prefix):
--   P50   1  .. 60
--   P150  61 .. 210
--   P50N  211 .. 250
--   P100  251 .. 350   (already physically present; matches shelf_slots seed)
--   P100X 351 .. 450   (projected, not yet arrived)

-- P50: 60 units, all scrap
insert into public.units (serial, batch, status, notes)
select 'LL01-' || lpad(n::text, 11, '0'), 'P50', 'scrap',
       'First batch, decommissioned.'
from generate_series(1, 60) n
on conflict (serial) do nothing;

-- P150: 150 units. Approximate the real distribution from the snapshot:
--   first 49 → shipped (delivered to customers)
--   next 50 → scrap    (defective, 35% defect rate)
--   remaining 51 → team-test (field testers and spares)
insert into public.units (serial, batch, status, notes)
select 'LL01-' || lpad((n+60)::text, 11, '0'), 'P150',
       case
         when n <= 49  then 'shipped'
         when n <= 99  then 'scrap'
         else 'team-test'
       end,
       case
         when n <= 49  then 'Shipped to customer (P150 early delivery batch).'
         when n <= 99  then 'Defective — 35% P150 defect rate cohort.'
         else 'In team member hands / demo use.'
       end
from generate_series(1, 150) n
on conflict (serial) do nothing;

-- P50N: 40 units. 36 shipped, 4 team-test (per user: "mostly shipped,
-- a few in office/team member homes for testing")
insert into public.units (serial, batch, status, notes)
select 'LL01-' || lpad((n+210)::text, 11, '0'), 'P50N',
       case when n <= 36 then 'shipped' else 'team-test' end,
       case when n <= 36 then 'Shipped to customer.' else 'Team / office testing unit.' end
from generate_series(1, 40) n
on conflict (serial) do nothing;

-- P100: 100 units. Matches the shelf_slots seed → all 'ready' for now.
-- Fulfillment Queue promotions to 'reserved'/'shipped' will happen via
-- app logic once the sync is wired.
insert into public.units (serial, batch, status, notes)
select 'LL01-' || lpad((n+250)::text, 11, '0'), 'P100',
       'ready',
       'On shelf at Toronto warehouse.'
from generate_series(1, 100) n
on conflict (serial) do nothing;

-- P100X: 100 units, all in-production (not yet arrived)
insert into public.units (serial, batch, status, notes)
select 'LL01-' || lpad((n+350)::text, 11, '0'), 'P100X',
       'in-production',
       'In production at Dongguan LC (projected Sep 2026).'
from generate_series(1, 100) n
on conflict (serial) do nothing;
