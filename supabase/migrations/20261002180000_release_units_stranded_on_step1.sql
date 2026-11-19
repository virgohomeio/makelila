-- Release the machines stranded on step-1 fulfillment rows, and un-assign the
-- machines a QC flag sent to rework.
--
-- Step 1 IS the assign step: a row sitting on it has nothing assigned. But
-- flagRework() used to rewind a row to step 1 by clearing assigned_serial
-- alone, leaving the real assignment behind in three places — the unit still
-- stamped with the customer's name and order, the fulfillment_queue_units link
-- still naming it, and a 'reserved' status on sibling machines nobody was
-- holding. Order #1286 collected six such links over six flag-and-re-pick
-- cycles (three units in 'rework', three still 'reserved'), and the queue told
-- the operator six machines were assigned to a customer she had not picked one
-- for.
--
-- The live hazard was step 6: sync_unit_on_fulfillment() marks every serial in
-- fulfillment_queue_units as 'shipped' to the order's customer, so the first
-- real shipment on one of these rows would have shipped the strays with it.
--
-- The app no longer creates these — flagRework() now releases the whole row,
-- and assignUnits() clears anything left on a step-1 row before it picks. This
-- cleans up what is already there.

begin;

-- 1. Units still 'reserved' against a step-1 row go back into sellable stock,
--    and their shelf slots are freed with them.
--
--    'rework', 'shipped' (backfill pairings) and everything else are left
--    alone: only a reservation made by the assign step is undone here.
with released as (
  update public.units u
     set status             = 'ready',
         customer_order_ref = null,
         customer_name      = null
   where u.status = 'reserved'
     and exists (
       select 1
         from public.fulfillment_queue_units fqu
         join public.fulfillment_queue fq on fq.id = fqu.queue_id
        where fqu.unit_serial = u.serial
          and fq.step <= 1
     )
  returning u.serial
)
update public.shelf_slots s
   set status     = 'available',
       updated_at = now()
  from released r
 where s.serial = r.serial
   and s.status <> 'available';

-- 2. Units parked in 'rework' by a fulfillment QC flag stop being owed to the
--    customer. They stay 'rework' — not sellable until Junaid clears the
--    defect — but no screen should still show a customer's name against them,
--    and no later step-6 sync should be able to ship them to that customer.
--    23 units are in this state today.
--
--    Scoped to defects raised by the flag button ('QC flag: …') on purpose. A
--    returned machine also sits in 'rework' carrying the name of whoever sent
--    it back ("Jenny Pho (returned)") — that is provenance, not an assignment,
--    and it stays.
update public.units u
   set customer_order_ref = null,
       customer_name      = null
 where u.status = 'rework'
   and (u.customer_name is not null or u.customer_order_ref is not null)
   and exists (
     select 1
       from public.build_defects d
      where d.unit_serial = u.serial
        and d.status in ('open', 'in_rework')
        and d.subject like 'QC flag:%'
   );

-- 3. Drop the links themselves. A step-1 row owns no units.
delete from public.fulfillment_queue_units fqu
 using public.fulfillment_queue fq
 where fq.id = fqu.queue_id
   and fq.step <= 1;

-- 4. And the single-serial column, for a row that never had child rows.
update public.fulfillment_queue
   set assigned_serial = null
 where step <= 1
   and assigned_serial is not null;

commit;
