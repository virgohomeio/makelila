-- Fulfillment › Queue: "received, date unknown".
--
-- The Received rail is driven by orders.delivered_at. Boxes that went out
-- before October 2026 were never confirmed one by one, and nobody knows the
-- day each one landed. Back-filling delivered_at with a guess (e.g. the ship
-- date) would put false delivery dates on the customer timeline, so this flag
-- marks them received with no date instead.

alter table public.orders
  add column if not exists received_undated boolean not null default false;

-- Every queue row whose box left before 2026-10-01 and has no arrival on
-- record. Ship date = fulfilled_at, else the shipping evidence the Shipped
-- rail itself uses (unit stamped with the order ref, or a shipment linked to
-- the order), matching queue/shippedMonths.ts. Closed-ticket replacements that
-- shipped outside the queue have only shipment rows, which the second branch
-- covers.
with ship as (
  select o.id,
         coalesce(
           fq.fulfilled_at,
           (select min(u.shipped_at) from public.units u
             where u.customer_order_ref = o.order_ref and u.status = 'shipped'),
           (select min(s.booked_at) from public.shipments s where s.order_id = o.id)
         ) as shipped_on,
         fq.fulfilled_at
  from public.fulfillment_queue fq
  join public.orders o on o.id = fq.order_id
  where o.delivered_at is null
    and o.status <> 'cancelled'
    and coalesce(o.reconcile_outcome, '') <> 'open'
)
update public.orders o
   set received_undated = true
  from ship
 where o.id = ship.id
   and ship.shipped_on < '2026-10-01';
