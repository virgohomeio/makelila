-- Walkthrough #22: shelf_slots had 74 stale rows still showing units that
-- had actually shipped (Junaid's example: serial LL01-00000000284 shipped
-- to Linda but the picker offered it to assign for Joseph). Two fixes:
--   1. One-shot cleanup of the historical drift.
--   2. Trigger to keep shelf_slots in sync when unit.status changes via
--      any code path (manual SQL, future Excel imports, queue rewind, etc.).
--
-- Note on data shape: we flip status to 'empty' but leave serial set.
-- shelf_slots.serial is the target of a FK from fulfillment_queue.assigned_serial,
-- so nullifying it errors for queue rows that haven't been deleted. The picker
-- filters by status='available' so 'empty' alone is enough to remove the unit
-- from the assign UI; keeping serial linked preserves the audit trail of which
-- physical unit was on that skid/slot before shipping.

-- 1. Cleanup.
update public.shelf_slots s
   set status = 'empty',
       updated_at = now()
  from public.units u
 where s.serial = u.serial
   and u.status in ('shipped','scrap','lost')
   and s.status != 'empty';

-- 2. Sync trigger.
create or replace function public.sync_shelf_slot_on_unit_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('shipped','scrap','lost') then
      update public.shelf_slots
         set status = 'empty',
             updated_at = now()
       where serial = new.serial
         and status != 'empty';
    elsif new.status = 'ready' then
      -- Unit came back to ready (e.g. rework recovery). Make its slot
      -- available again so the picker resurfaces it.
      update public.shelf_slots
         set status = 'available',
             updated_at = now()
       where serial = new.serial
         and status in ('reserved','rework','empty');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_shelf_slot_on_unit_status_change on public.units;
create trigger trg_sync_shelf_slot_on_unit_status_change
  after update of status on public.units
  for each row
  execute function public.sync_shelf_slot_on_unit_status_change();
