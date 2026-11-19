-- Shelf: organise slots into location sections, and give Flex Space stock a
-- pallet-level layout.
--
-- Until now `shelf_slots` was a single implicit site (the Toronto/VentureLab
-- floor) with a fixed A1-A30 x 5 grid. The only record of *where* the shelf was
-- lived in free text in `units.notes` ("On shelf at Toronto warehouse"). With
-- 250 units now held at the Flex Space Logistics 3PL, and EZTrans + a US
-- warehouse coming, the board needs to say which building a skid is in.
--
-- Sections: VentureLab | Flex Space Logistics | EZTrans | US Warehouse.
-- Within a section the `skid` column is the grouping unit -- a physical skid at
-- VentureLab, a pallet at Flex Space.

-- ---------------------------------------------------------------------------
-- 0. Backup. This migration clears ~98 slots that hold serials for machines
--    that are no longer on any shelf. Keep a copy of the pre-change board.
-- ---------------------------------------------------------------------------
create table if not exists public.shelf_slots_backup_20260910 as
  select * from public.shelf_slots;

-- ---------------------------------------------------------------------------
-- 1. units.pallet -- promote the shipment-1 pallet map out of free-text notes.
-- ---------------------------------------------------------------------------
alter table public.units add column if not exists pallet text;

comment on column public.units.pallet is
  'Pallet the unit arrived on, where the manufacturer supplied a pallet-level '
  'manifest. NULL means no manifest was provided for that shipment -- do not '
  'infer a pallet from the serial, the 5-per-pallet run only holds for the '
  '2026-07-20 P100X shipment.';

-- Shipment 1 (2026-07-20): serials 351-420, five units per pallet, pallets
-- 1/16-14/16. Pallets 15/16 and 16/16 were bulk compost chambers and are
-- booked to `parts`, not here. Shipments 2 and 3 came with no pallet manifest,
-- so 180 units stay NULL rather than being given invented pallet numbers.
update public.units
   set pallet = 'P' || lpad(((((substring(serial from '(\d+)$')::int - 351) / 5) + 1))::text, 2, '0')
 where serial like 'LL01-%'
   and substring(serial from '(\d+)$')::int between 351 and 420
   and pallet is null;

-- ---------------------------------------------------------------------------
-- 2. shelf_slots.location + room for groups larger than five slots.
-- ---------------------------------------------------------------------------
alter table public.shelf_slots
  add column if not exists location text not null default 'VentureLab';

comment on column public.shelf_slots.location is
  'Which building this skid/pallet physically sits in. Drives the section '
  'grouping in Fulfillment > Shelf.';

alter table public.shelf_slots drop constraint if exists shelf_slots_location_check;
alter table public.shelf_slots add constraint shelf_slots_location_check
  check (location in ('VentureLab', 'Flex Space Logistics', 'EZTrans', 'US Warehouse'));

-- A VentureLab skid holds 5. A Flex Space pallet holds 5 where we have a
-- manifest, but the un-manifested shipments arrive as one undifferentiated
-- group of 90, so the 0-4 cap has to go.
alter table public.shelf_slots drop constraint if exists shelf_slots_slot_index_check;
alter table public.shelf_slots add constraint shelf_slots_slot_index_check
  check (slot_index >= 0 and slot_index <= 199);

create index if not exists idx_shelf_slots_location on public.shelf_slots (location);

-- ---------------------------------------------------------------------------
-- 3. Release everything that isn't actually on a shelf any more.
--
--    The status-sync trigger flips a slot to 'empty' when its unit ships, but
--    never clears `serial` -- so 96 of 100 occupied slots were ghosts holding
--    the serial of a machine now at a customer address, and two more held
--    team-test units that are physically with Hassan and Pedrum.
--
--    Anything whose unit is not ready/reserved/rework is released. That leaves
--    LL01-...00305 (reserved) and LL01-...00332 (ready) in place.
-- ---------------------------------------------------------------------------
update public.shelf_slots s
   set serial = null, batch = null, status = 'empty', updated_at = now()
  from public.units u
 where u.serial = s.serial
   and u.status not in ('ready', 'reserved', 'rework');

-- Slots holding a serial with no matching unit row at all (none expected).
update public.shelf_slots s
   set serial = null, batch = null, status = 'empty', updated_at = now()
 where s.serial is not null
   and not exists (select 1 from public.units u where u.serial = s.serial);

-- ---------------------------------------------------------------------------
-- 4. Lay out the Flex Space section.
--
--    FS-P01..FS-P14 -- the 2026-07-20 manifest, 5 units each.
--    FS-S2 / FS-S3  -- the 2026-08-06 and 2026-09-04 shipments, which arrived
--                      with no pallet breakdown. One group each, deliberately
--                      not split into fake pallets of five.
-- ---------------------------------------------------------------------------
insert into public.shelf_slots (skid, slot_index, serial, batch, status, location, updated_at)
select
  'FS-' || u.pallet,
  ((substring(u.serial from '(\d+)$')::int - 351) % 5)::smallint,
  u.serial,
  u.batch,
  'available',
  'Flex Space Logistics',
  now()
from public.units u
where u.location = 'Flex Space Logistics'
  and u.pallet is not null
on conflict (skid, slot_index) do nothing;

insert into public.shelf_slots (skid, slot_index, serial, batch, status, location, updated_at)
select
  case when n between 421 and 510 then 'FS-S2' else 'FS-S3' end,
  (row_number() over (
     partition by case when n between 421 and 510 then 'FS-S2' else 'FS-S3' end
     order by n
   ) - 1)::smallint,
  serial,
  batch,
  'available',
  'Flex Space Logistics',
  now()
from (
  select serial, batch, substring(serial from '(\d+)$')::int as n
  from public.units
  where location = 'Flex Space Logistics' and pallet is null
) q
on conflict (skid, slot_index) do nothing;

-- ---------------------------------------------------------------------------
-- 5. A drag must not teleport a machine between buildings.
-- ---------------------------------------------------------------------------
create or replace function public.swap_shelf_slots(
  a_skid text, a_slot_index smallint, b_skid text, b_slot_index smallint
)
returns void
language plpgsql
as $function$
declare
  row_a record;
  row_b record;
  now_ts timestamptz := now();
begin
  select serial, batch, status, location into row_a from public.shelf_slots
    where skid = a_skid and slot_index = a_slot_index;
  if not found then
    raise exception 'swap_shelf_slots: source slot % / % not found', a_skid, a_slot_index;
  end if;
  select serial, batch, status, location into row_b from public.shelf_slots
    where skid = b_skid and slot_index = b_slot_index;
  if not found then
    raise exception 'swap_shelf_slots: target slot % / % not found', b_skid, b_slot_index;
  end if;

  if row_a.location is distinct from row_b.location then
    raise exception 'swap_shelf_slots: % and % are in different locations (% vs %) -- a machine cannot be moved between buildings by dragging',
      a_skid, b_skid, row_a.location, row_b.location;
  end if;

  -- Step 1: clear A to release the serial uniqueness
  update public.shelf_slots
     set serial = null, batch = null, status = 'empty', updated_at = now_ts
   where skid = a_skid and slot_index = a_slot_index;

  -- Step 2: move A's original values into B
  update public.shelf_slots
     set serial = row_a.serial, batch = row_a.batch, status = row_a.status, updated_at = now_ts
   where skid = b_skid and slot_index = b_slot_index;

  -- Step 3: move B's original values into A
  update public.shelf_slots
     set serial = row_b.serial, batch = row_b.batch, status = row_b.status, updated_at = now_ts
   where skid = a_skid and slot_index = a_slot_index;
end;
$function$;
