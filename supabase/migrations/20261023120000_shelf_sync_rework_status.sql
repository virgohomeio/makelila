-- Logging a unit as 'rework' in Stock left its shelf slot green.
--
-- sync_shelf_slot_on_unit_status_change() skipped 'rework' (and 'reserved')
-- entirely, on the assumption that only the Fulfillment "Flag rework" button
-- ever set it — and that button flips the slot itself. A status change made
-- from Stock therefore never reached the shelf: LL01-…449 and LL01-…460 sat
-- 'available' on EZ-S2 while their machines were in rework, and the Assign
-- step could still have picked them.
--
-- 'rework' now flips the slot red. 'reserved' is still left alone: the assign
-- flow owns that transition and writes the slot in the same pass.

create or replace function public.sync_shelf_slot_on_unit_status_change()
returns trigger
language plpgsql
as $function$
begin
  if new.status is distinct from old.status then
    if new.status = 'ready' then
      update public.shelf_slots
         set status = 'available',
             updated_at = now()
       where serial = new.serial
         and status in ('reserved','rework','empty','held');
    elsif new.status = 'rework' then
      update public.shelf_slots
         set status = 'rework',
             updated_at = now()
       where serial = new.serial
         and status != 'rework';
    elsif new.status in ('team-test','quarantine') then
      update public.shelf_slots
         set status = 'held',
             updated_at = now()
       where serial = new.serial
         and status != 'held';
    elsif new.status <> 'reserved' then
      update public.shelf_slots
         set status = 'empty',
             updated_at = now()
       where serial = new.serial
         and status != 'empty';
    end if;
  end if;
  return new;
end;
$function$;

-- Backfill: every shelved machine already in rework.
update public.shelf_slots s
   set status = 'rework',
       updated_at = now()
  from public.units u
 where u.serial = s.serial
   and u.status = 'rework'
   and s.status <> 'rework';
