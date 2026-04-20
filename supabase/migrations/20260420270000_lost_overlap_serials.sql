-- Populate rows for serials that belong to P50 or P150 on paper but aren't
-- represented in the units table because P50 (1-50) and P150 (1-150) serial
-- numbers overlap and the units table has a single-row-per-serial PK.
--
-- For each overlapping serial number, one physical unit's row exists and
-- the "other batch" copy is unaccounted for. Create a synthetic row for
-- that missing unit with status='lost'. Suffix '-L' on the serial keeps
-- the PK distinct while preserving the original number for traceability.
--
-- Result after migration:
--   P50  rows: 35 existing (VIP/scrap) + 15 lost = 50 (matches batch size)
--   P150 rows: 115 existing (1-150)      + 35 lost = 150 (matches batch size)

-- -------- Lost P50 units (the "other half" of serials currently held by P150) --------
insert into public.units (serial, batch, status, notes)
select
  'LL01-' || lpad(n::text, 11, '0') || '-L',
  'P50',
  'lost',
  'P50 original at serial ' || lpad(n::text, 11, '0')
    || ' — physical unit unaccounted for. The plain-serial row at this number is the P150 refurb that replaced it.'
from unnest(array[4, 7, 16, 17, 19, 21, 23, 25, 26, 33, 43, 44, 45, 49, 50]) as t(n)
on conflict (serial) do nothing;

-- -------- Lost P150 units (the "other half" of serials currently held by P50 VIPs) --------
insert into public.units (serial, batch, status, notes)
select
  'LL01-' || lpad(n::text, 11, '0') || '-L',
  'P150',
  'lost',
  'P150 unit at serial ' || lpad(n::text, 11, '0')
    || ' — physical unit lost track. The plain-serial row at this number is a P50 VIP original.'
from unnest(array[
  1, 2, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 18, 20, 22, 24, 27, 28, 29,
  30, 31, 32, 34, 35, 36, 37, 38, 39, 40, 41, 42, 46, 47, 48
]) as t(n)
on conflict (serial) do nothing;
