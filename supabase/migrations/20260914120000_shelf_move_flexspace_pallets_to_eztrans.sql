-- Shelf: every pallet held at Flex Space Logistics has moved to EZTrans.
--
-- 250 units on 16 groups -- FS-P01..FS-P14 (the 2026-07-20 manifest) and
-- FS-S2 / FS-S3 (the two un-manifested shipments). The move is recorded in
-- both places a location lives: shelf_slots.location drives the Shelf board,
-- units.location drives Stock.
--
-- The skid keys are renamed FS- -> EZ- so a pallet under EZTrans doesn't carry
-- a label that reads as Flex Space. Nothing references shelf_slots.skid (no FK,
-- no function body mentions the FS- names), and pallet / slot_index / serial
-- are untouched, so the layout inside each pallet is preserved.
--
-- Flex Space Logistics stays in shelf_slots_location_check: the 3PL contract
-- and its rate card (profitability bucket 11) still exist; it just holds no
-- stock now.

create table if not exists public.shelf_slots_backup_20260914 as
  select * from public.shelf_slots;

update public.shelf_slots
   set location = 'EZTrans',
       skid = regexp_replace(skid, '^FS-', 'EZ-'),
       updated_at = now()
 where location = 'Flex Space Logistics';

update public.units
   set location = 'EZTrans'
 where location = 'Flex Space Logistics';
