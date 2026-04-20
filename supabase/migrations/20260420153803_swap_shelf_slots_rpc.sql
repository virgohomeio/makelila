-- swap_shelf_slots: atomically swap (serial, batch, status) between two shelf slots.
-- The UNIQUE(serial) constraint on shelf_slots forbids the direct two-UPDATE approach
-- (both slots would briefly hold the same serial). This function uses a 3-step
-- approach (clear A → move A's values to B → move B's original values to A),
-- all within a single transaction so a failure rolls back atomically.
create or replace function public.swap_shelf_slots(
  a_skid text, a_slot_index smallint,
  b_skid text, b_slot_index smallint
) returns void language plpgsql as $$
declare
  row_a record;
  row_b record;
  now_ts timestamptz := now();
begin
  select serial, batch, status into row_a from public.shelf_slots
    where skid = a_skid and slot_index = a_slot_index;
  if not found then
    raise exception 'swap_shelf_slots: source slot % / % not found', a_skid, a_slot_index;
  end if;
  select serial, batch, status into row_b from public.shelf_slots
    where skid = b_skid and slot_index = b_slot_index;
  if not found then
    raise exception 'swap_shelf_slots: target slot % / % not found', b_skid, b_slot_index;
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
$$;

grant execute on function public.swap_shelf_slots(text, smallint, text, smallint) to authenticated;
