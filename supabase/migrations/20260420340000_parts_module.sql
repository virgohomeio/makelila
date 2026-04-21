-- Parts module: replacement parts + consumables.
--
-- Two new tables:
--
--   parts: master catalog of part SKUs we track. category='replacement'
--     for items shipped to fix defective units (top lids, motors,
--     sensors). category='consumable' for things bundled with each unit
--     sale (starter kits, boxes, manuals).
--
--   part_shipments: outbound part shipments to specific customers, with
--     a soft FK to units.serial when the shipment is tied to a specific
--     LILA unit (e.g. a top lid sent to fix a P150 buyer's lid issue).
--
-- Seeds:
--   - top-lid (P150 replacement): 40 ordered with P50N (Dec 2025), 3
--     shipped with P100 batch (Anthony Kurt, Douglas Hanson, Frederick
--     Whittington in mid-Apr 2026), 37 on hand.
--   - starter-kit (US consumable): shipped via Amazon with every US LILA
--     order. Inventory not held by us (Amazon-fulfilled), so on_hand=0
--     and shipments tracked per US fulfillment.

-- ============================================================================
-- parts
-- ============================================================================
create table if not exists public.parts (
  id text primary key,
  sku text not null unique,
  name text not null,
  category text not null check (category in ('replacement','consumable')),
  kind text,
  supplier text,
  supplier_url text,
  cost_per_unit_usd numeric(10,2),
  on_hand int not null default 0,
  reorder_point int not null default 0,
  location text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_parts_category on public.parts (category);

alter table public.parts enable row level security;
create policy "parts_select" on public.parts for select to authenticated using (true);
create policy "parts_insert" on public.parts for insert to authenticated with check (true);
create policy "parts_update" on public.parts for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.parts;

create or replace function public.touch_parts_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists parts_touch on public.parts;
create trigger parts_touch before update on public.parts
  for each row execute function public.touch_parts_updated_at();

-- ============================================================================
-- part_shipments
-- ============================================================================
create table if not exists public.part_shipments (
  id uuid primary key default gen_random_uuid(),
  part_id text not null references public.parts(id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  customer_name text,
  linked_unit_serial text,             -- soft ref to units.serial; not enforced FK
  linked_order_ref text,
  carrier text,
  tracking_num text,
  shipped_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_partshipments_part on public.part_shipments (part_id);
create index if not exists idx_partshipments_shipped on public.part_shipments (shipped_at desc);

alter table public.part_shipments enable row level security;
create policy "partshipments_select" on public.part_shipments for select to authenticated using (true);
create policy "partshipments_insert" on public.part_shipments for insert to authenticated with check (true);
create policy "partshipments_update" on public.part_shipments for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.part_shipments;

-- Decrement on_hand when a part ships (replacement parts only — consumables
-- aren't physically held by us, so they stay at 0 and the shipment row is
-- the source of truth).
create or replace function public.dec_part_on_hand() returns trigger language plpgsql as $$
declare cat text;
begin
  select category into cat from public.parts where id = new.part_id;
  if cat = 'replacement' then
    update public.parts
       set on_hand = greatest(0, on_hand - new.quantity)
     where id = new.part_id;
  end if;
  return new;
end $$;

drop trigger if exists partshipment_decrement on public.part_shipments;
create trigger partshipment_decrement
  after insert on public.part_shipments
  for each row execute function public.dec_part_on_hand();

-- ============================================================================
-- Seed parts
-- ============================================================================
insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('P-LID-V36',  'LILA-LID-V36', 'Replacement Top Lid (v3.6)',
    'replacement', 'top-lid', 'Dongguan LC Technology', 24.00,
    40, 10, 'Toronto warehouse',
    'Replacement top lids for P150 batch defects. 40 ordered with P50N batch (arrived Dec 5, 2025).'),
  ('P-MOTOR',    'LILA-MOTOR-MAIN', 'Main Crushing Motor',
    'replacement', 'motor', 'Ningbo MBV Kangmei', null,
    0, 5, 'Toronto warehouse',
    'Replacement motor for P50/P150 motor failures. Track on hand; reorder when low.'),
  ('C-STARTER',  'LILA-STARTER-KIT', 'Compost Starter Kit',
    'consumable',  'starter-kit', 'Amazon (FBA)', 12.00,
    0, 0, 'Amazon FBA',
    'Bundled with every US LILA shipment. Amazon-fulfilled, no warehouse stock.'),
  ('C-BOX',      'LILA-BOX-OEM', 'OEM Shipping Box',
    'consumable',  'box', 'Local supplier', 8.00,
    50, 20, 'Toronto warehouse',
    'Original shipping box for new LILA shipments. Required for return-eligible repackaging.'),
  ('C-MANUAL',   'LILA-MANUAL-EN', 'User Manual (English)',
    'consumable',  'manual', 'Print supplier', 1.50,
    100, 30, 'Toronto warehouse', null)
on conflict (id) do nothing;

-- ============================================================================
-- Seed part shipments (the 3 top-lid replacements shipped with P100 batch)
-- ============================================================================
-- Note: trigger will decrement P-LID-V36.on_hand by 3 on insert (40 → 37).
insert into public.part_shipments
  (part_id, quantity, customer_name, carrier, shipped_at, notes)
values
  ('P-LID-V36', 1, 'Anthony Kurt',          'UPS', '2026-04-16',
    'Top lid replacement for P150 unit (orig serial 212).'),
  ('P-LID-V36', 1, 'Douglas Hanson',        'UPS', '2026-04-16',
    'Top lid replacement for P150 unit (orig serial 232).'),
  ('P-LID-V36', 1, 'Frederick Whittington', 'UPS', '2026-04-16',
    'Top lid replacement for P150 unit (orig serial 234).')
on conflict do nothing;
