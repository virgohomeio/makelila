-- P100 batch is 100 units (serials LL01-00000000251 .. LL01-00000000350).
-- Fill skids A1-A20 (5 slots each = 100 slots). The remaining 50 slots on
-- A21-A30 stay empty so the shelf visual keeps all 150 positions.
--
-- The DELETE cascades ON DELETE SET NULL on fulfillment_queue.assigned_serial,
-- so any in-flight queue rows that referenced old serials will need a fresh
-- Assign. Current queue has no step>1 rows, so this is safe.

delete from public.shelf_slots;

-- 100 occupied P100 slots, A1-A20 × slots 0..4
insert into public.shelf_slots (skid, slot_index, serial, batch, status)
select
  'A' || skid_num,
  slot_idx,
  'LL01-' || lpad((250 + (skid_num - 1) * 5 + slot_idx + 1)::text, 11, '0'),
  'P100',
  'available'
from generate_series(1, 20) as skid_num
cross join generate_series(0, 4) as slot_idx;

-- 50 empty placeholder slots, A21-A30 × slots 0..4
insert into public.shelf_slots (skid, slot_index, serial, batch, status)
select
  'A' || skid_num,
  slot_idx,
  null,
  null,
  'empty'
from generate_series(21, 30) as skid_num
cross join generate_series(0, 4) as slot_idx;
