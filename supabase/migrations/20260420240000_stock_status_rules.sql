-- Apply 2026-04-20 ops rules to refine default unit statuses:
--
-- 1. P150 units currently 'ready' flip to 'rework'. The batch had a 35%
--    defect rate — every remaining unit on the shelf needs triage before
--    it can ship to a customer.
-- 2. P50N units without an assigned customer are team/office testing units
--    rather than ready-for-sale stock (status='team-test').
-- 3. P100 units that haven't been shipped or queued yet are still
--    undergoing CA test (status='ca-test').
-- 4. P100 physical location is "MicroArt Warehouse" — set on every P100
--    unit that isn't already with a customer.
--
-- Shipped rows are left alone in every case so we don't overwrite real
-- fulfillment data.

-- 1. P150 ready → rework
update public.units
   set status = 'rework',
       defect_reason = coalesce(defect_reason, 'Pending triage (P150 batch 35% defect rate).'),
       notes = coalesce(notes, 'Moved to rework per 2026-04-20 triage pass.')
 where batch = 'P150' and status = 'ready';

-- 2. P50N without a customer → team-test
update public.units
   set status = 'team-test',
       location = coalesce(nullif(location, ''), 'Team / office'),
       notes = coalesce(notes, 'P50N unit in team/office testing (no customer).')
 where batch = 'P50N' and customer_name is null;

-- 3. P100 ready → ca-test. (Reserved rows with printed labels stay
--    reserved — they're past the ca-test phase. Shipped stays shipped.)
update public.units
   set status = 'ca-test',
       notes = coalesce(notes, 'Undergoing CA testing at MicroArt Warehouse.')
 where batch = 'P100' and status = 'ready';

-- 4. P100 physical location → MicroArt Warehouse (everything not already
--    out with a customer).
update public.units
   set location = 'MicroArt Warehouse'
 where batch = 'P100' and status <> 'shipped';
