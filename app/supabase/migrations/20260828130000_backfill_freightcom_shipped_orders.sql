-- Backfill: pending orders that Freightcom already delivered (2026-08-28)
--
-- 41 orders sat in `pending` with a Freightcom shipment booked against the
-- order itself — 47 of the 48 shipment rows read `delivered`. The link is
-- unambiguous, so unlike the customer-level ambiguity the Reconcile screen
-- exists for (lib/reconcile.ts), these need no human judgement.
--
-- Three are excluded by the WHERE clause below and left for a person:
--   • #1031  — its unit LL01-00000000239 is currently in `rework` with a later
--              shipped_at than the delivery. Linking it would flip the unit back
--              to `shipped` and overwrite the rework state.
--   • R-0034, R-0042 — replacements. They belong to the service-ticket flow,
--              and closing them from here bypasses that linkage.
-- That leaves 38.
--
-- Why label_confirmed_at is the *unit's own* shipped_at rather than the
-- shipment's date: the fq_sync_unit trigger writes units.shipped_at =
-- coalesce(label_confirmed_at, fulfilled_at, now()). Leaving both null would
-- stamp today over the real ship date on 38 machines; feeding it the Freightcom
-- booking would move 12 of them by up to 10.5 days. Handing back the value the
-- unit already holds makes the trigger a no-op on that column. This backfill
-- records an order's fulfilment — it does not re-date machines.
--
-- No email is sent by any of this. Step 5 is what mails the customer and this
-- never passes through it (email_sent_at stays null), and the welcome mail on
-- customer_lifecycle can't fire either: units_create_lifecycle_on_ship only
-- runs when a unit's status *changes* to shipped, and all 38 are already
-- shipped — each one verified to hold a lifecycle row already.

begin;

create temporary table _backfill_targets on commit drop as
with pick as (
  -- One shipment per order: a delivered one wins, then the earliest booking.
  select distinct on (s.order_id)
         s.order_id,
         s.unit_serial,
         s.carrier,
         s.primary_tracking_number,
         coalesce(s.picked_up_at, s.booked_at)                 as shipped_ts,
         coalesce(s.delivered_at, s.picked_up_at, s.booked_at) as fulfilled_ts,
         s.delivered_at
  from public.shipments s
  join public.orders o on o.id::text = s.order_id::text
  where o.status = 'pending'
  order by s.order_id, (s.delivered_at is null), s.booked_at asc
)
select o.id as order_id,
       o.order_ref,
       pick.unit_serial,
       pick.carrier,
       pick.primary_tracking_number as tracking_num,
       -- The unit's own date wins, so the trigger writes back what is already there.
       coalesce(u.shipped_at, pick.shipped_ts) as shipped_ts,
       pick.fulfilled_ts,
       pick.delivered_at
from pick
join public.orders o on o.id::text = pick.order_id::text
left join public.units u on u.serial = pick.unit_serial
where o.status = 'pending'
  and o.kind = 'sale'
  and pick.fulfilled_ts is not null
  -- Only touch a unit that is already shipped. Anything else (rework,
  -- quarantine, still on the shelf) is a contradiction a person must read.
  and pick.unit_serial is not null
  and u.status = 'shipped';

-- Approving is what creates the queue row, via auto_enqueue_on_approve.
update public.orders o
set status            = 'approved',
    shipped_at        = t.shipped_ts,
    delivered_at      = coalesce(o.delivered_at, t.delivered_at),
    dispositioned_at  = now(),
    reconciled_at     = now(),
    reconciled_by     = 'system:freightcom-backfill',
    reconcile_outcome = 'shipped',
    reconcile_note    = 'Backfilled from the Freightcom shipment booked against this order'
from _backfill_targets t
where o.id = t.order_id;

-- Then close that row at step 6, carrying the shipment's own timestamps.
update public.fulfillment_queue q
set step                  = 6,
    assigned_serial       = t.unit_serial,
    carrier               = coalesce(q.carrier, t.carrier),
    tracking_num          = coalesce(q.tracking_num, t.tracking_num),
    label_confirmed_at    = t.shipped_ts,
    fulfilled_at          = t.fulfilled_ts,
    reconciled_at         = now(),
    reconciliation_source = 'freightcom_backfill'
from _backfill_targets t
where q.order_id = t.order_id;

commit;
