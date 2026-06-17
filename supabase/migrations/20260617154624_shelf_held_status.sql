-- Bug: a unit moved to 'team-test' (reported example: serial LL01-00000000319,
-- pulled for team testing) kept showing GREEN/available on the Fulfillment
-- shelf and stayed pickable. Two pre-existing gaps:
--   1. The shelf sync trigger (20260603130000) only handled shipped/scrap/lost
--      → empty and ready → available. Every other unit status — team-test,
--      quarantine, and the production/inbound/test states — fell through and
--      left the slot at whatever it was (usually 'available' = green).
--   2. shelf_slots.status had no value to represent "on the skid but out of
--      circulation", so quarantine units (added in 20260610000000) were only
--      guarded at assign time and ALSO still rendered green.
--
-- Fix: add a 'held' shelf status (distinct amber color) for team-test +
-- quarantine, and make the trigger fail safe — on-shelf is the known small
-- set (ready/reserved/rework/held); anything else leaves the shelf as 'empty'.
-- A new UnitStatus added later defaults to unpickable instead of green.

-- 1. Widen the status check constraint so 'held' is writable.
alter table public.shelf_slots drop constraint if exists shelf_slots_status_check;
alter table public.shelf_slots add constraint shelf_slots_status_check
  check (status in ('available','reserved','rework','empty','held'));

-- 2. Rewrite the sync trigger function (trigger definition itself unchanged).
--    As before, we flip status but leave serial set: shelf_slots.serial is the
--    FK target from fulfillment_queue.assigned_serial, so nulling it errors for
--    queue rows that still reference it. The picker filters status='available',
--    so a non-available status alone removes the unit from circulation while
--    preserving the audit trail of which physical unit sat on that slot.
create or replace function public.sync_shelf_slot_on_unit_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'ready' then
      -- Unit came (back) to ready — resurface it for the picker.
      update public.shelf_slots
         set status = 'available',
             updated_at = now()
       where serial = new.serial
         and status in ('reserved','rework','empty','held');
    elsif new.status in ('team-test','quarantine') then
      -- On the skid but out of circulation — show distinct, not pickable.
      update public.shelf_slots
         set status = 'held',
             updated_at = now()
       where serial = new.serial
         and status != 'held';
    elsif new.status not in ('reserved','rework') then
      -- Everything else (shipped, scrap, lost, in-production, inbound,
      -- cn-test, ca-test, and any future status) leaves the shelf.
      -- reserved/rework are app-managed mid-fulfillment, left untouched.
      update public.shelf_slots
         set status = 'empty',
             updated_at = now()
       where serial = new.serial
         and status != 'empty';
    end if;
  end if;
  return new;
end;
$$;

-- 3. One-shot backfill: the trigger only fires on future changes, so reconcile
--    rows that already drifted (e.g. LL01-00000000319 and any quarantine units
--    still showing green). Mirrors the trigger's routing.
update public.shelf_slots s
   set status = case
         when u.status in ('team-test','quarantine') then 'held'
         else 'empty'
       end,
       updated_at = now()
  from public.units u
 where s.serial = u.serial
   and u.status not in ('ready','reserved','rework')
   and s.status not in ('empty','held');
