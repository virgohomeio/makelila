-- Repair: a replacement stamped shipped whose fulfillment_queue row never moved.
--
-- R-0069 (Robert & Lynda Simoneau, a replacement jumper for ticket
-- ST-2026-0520) went out on 2026-09-29 in an Amazon box. The operator typed
-- "Amazon" into the free-text Carrier field on Fulfillment > Queue and clicked
-- Mark shipped. markPartsReplacementShipped() stamped `orders` first — free
-- text, accepted — then upserted the queue row at step 6 carrying the same
-- carrier, and fulfillment_queue.carrier is CHECK-constrained to six freight
-- carriers (fulfillment_queue_carrier_check). The upsert threw.
--
-- What that left behind: an order reading shipped, its queue row still at
-- step 1, no activity_log entry for the shipment, and the ticket still tagged
-- "Queued for Replacement". The order showed as shipped on every screen except
-- the one the picker works from, where it sat in "Ready to ship" as an
-- invitation to send a second jumper. The retry was blocked by its own
-- half-written state: shipped_at was set, so the button that would have
-- finished the job refused to run.
--
-- The app-side fix (lib/queueCarrier.ts + the reordered writes in
-- markPartsReplacementShipped) stops it recurring. This migration repairs the
-- rows it already produced.
--
-- Scope — only a shipped_at this can trust. `o.shipped_at > q.created_at` is
-- the discriminator, and it is the same reasoning lib/shippedOrders.ts uses for
-- its 'in-queue' signal: a shipment recorded AFTER the row was queued cannot be
-- an older one of the customer's mis-attributed to it. That matches R-0069
-- (queued 09-28, shipped 09-29) and deliberately excludes R-0005, R-0027 and
-- R-0031, whose shipped_at values (Feb-Apr 2026) predate their August queueing
-- because the June 2026 import matched each replacement to whatever the
-- customer had last received. Those dates are known bad; writing them into
-- fulfilled_at would launder them into the shipping record. All three are
-- already masked out of "Ready to ship" by the ticket-closed signal, which is
-- the right net for them.
--
-- Safe to re-run: every statement is a no-op once applied.

create temp table _repair_targets as
select q.id           as queue_id,
       o.id           as order_id,
       o.order_ref    as order_ref,
       o.shipped_at   as shipped_at,
       o.carrier      as carrier,
       o.linked_ticket_id as ticket_id
  from public.fulfillment_queue q
  join public.orders o on o.id = q.order_id
 where q.step < 6
   and q.fulfilled_at is null
   -- Never a row with a machine on it. assigned_serial is what flips a unit to
   -- 'shipped' (fq_sync_unit) and registers its warranty, so a sale or a unit
   -- replacement mid-flight is left for a person to walk to step 6.
   and q.assigned_serial is null
   and o.kind = 'replacement'
   and o.status <> 'cancelled'
   and o.shipped_at is not null
   and o.shipped_at > q.created_at;

-- ── 1. Close the queue row out ──────────────────────────────────────────────
-- fulfilled_at takes the order's own shipped_at, not now(): the box left on the
-- 29th and the Shipped tab buckets by month.
update public.fulfillment_queue q
   set step = 6,
       fulfilled_at = r.shipped_at,
       -- Only a carrier this column accepts, and never over one already on the
       -- row from step 4. "Amazon" is kept on the order and left out here —
       -- exactly what the app now does.
       carrier = coalesce(
         q.carrier,
         case when r.carrier = any (array['UPS','FedEx','Purolator','Canada Post','Canpar','GLS'])
              then r.carrier end)
  from _repair_targets r
 where q.id = r.queue_id;

-- ── 2. The ticket half, which never ran either ──────────────────────────────
-- Same rule the app applies: the case comes off "Queued for Replacement" only
-- when nothing else on it is still owed.
create temp table _repair_tickets as
select distinct r.ticket_id
  from _repair_targets r
 where r.ticket_id is not null
   and not exists (
     select 1
       from public.orders o2
      where o2.linked_ticket_id = r.ticket_id
        and o2.kind = 'replacement'
        and o2.status <> 'cancelled'
        and o2.shipped_at is null
        and o2.delivered_at is null
   );

update public.service_tickets t
   set tags = array_remove(coalesce(t.tags, '{}'), 'queued_for_replacement')
  from _repair_tickets k
 where t.id = k.ticket_id
   and 'queued_for_replacement' = any (coalesce(t.tags, '{}'));

-- A closed case stays closed, and the tag array may not duplicate the primary
-- status.
update public.service_tickets t
   set tags = array_append(coalesce(t.tags, '{}'), 'replacement_sent')
  from _repair_tickets k
 where t.id = k.ticket_id
   and t.status not in ('closed', 'replacement_sent')
   and not ('replacement_sent' = any (coalesce(t.tags, '{}')));

-- ── 3. The audit trail ──────────────────────────────────────────────────────
-- logAction() runs after the upsert that failed, so the shipment is absent from
-- the log entirely. activity_log.user_id is NOT NULL and a migration has no
-- auth.uid(), so the entry is attributed to the operator who last acted on this
-- order — the same person who raised and queued it. No such row to borrow a
-- user from means no log entry rather than a wrong one.
insert into public.activity_log (user_id, ts, type, entity, detail)
select al.user_id,
       r.shipped_at,
       'replacement_shipped',
       r.order_ref,
       'parts replacement marked shipped'
         || coalesce(' · ' || r.carrier, '')
         || ' · queue row closed out by migration 20260930120000'
  from _repair_targets r
  join lateral (
    select a.user_id
      from public.activity_log a
     where a.entity = r.order_ref
     order by a.ts desc
     limit 1
  ) al on true
 where not exists (
   select 1
     from public.activity_log a2
    where a2.entity = r.order_ref
      and a2.type = 'replacement_shipped'
 );

do $$
declare n int;
begin
  select count(*) into n from _repair_targets;
  raise notice 'shipped-replacement queue repair: % row(s)', n;
end $$;

drop table if exists _repair_targets;
drop table if exists _repair_tickets;
