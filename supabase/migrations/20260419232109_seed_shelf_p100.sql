-- Seed 150 P100 units across 30 skids (A1-A30, 5 slots each).
-- Batch P100 arrived April 13, 2026. Slot indexes: 0,1,2 top (portrait); 3,4 bottom (landscape).
insert into public.shelf_slots (skid, slot_index, serial, batch, status)
select
  'A' || skid_num  as skid,
  slot_idx         as slot_index,
  'LL01-' || lpad(((skid_num - 1) * 5 + slot_idx + 1)::text, 11, '0') as serial,
  'P100'           as batch,
  'available'      as status
from generate_series(1, 30) as skid_num
cross join generate_series(0, 4) as slot_idx
on conflict (skid, slot_index) do update
  set serial = excluded.serial,
      batch = excluded.batch,
      status = excluded.status;
