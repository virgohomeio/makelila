-- Add 'quarantine' to the units.status check constraint.
--
-- Quarantine is used when a unit must be held for investigation (e.g. a
-- returned unit pending inspection, a unit flagged for potential firmware
-- or safety issue).  It is intentionally excluded from fulfillment queue
-- picks — a quarantined unit must not be assigned to any order until an
-- operator explicitly moves it back to a pickable status (ready, ca-test).

alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check check (status in (
  'in-production','inbound','ca-test',
  'ready','reserved','rework',
  'shipped','team-test','scrap','lost','quarantine'
));
