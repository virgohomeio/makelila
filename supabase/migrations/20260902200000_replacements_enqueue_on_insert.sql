-- Replacements go to the Fulfillment queue, not to Sales.
--
-- createReplacementOrder() now inserts kind='replacement' rows already
-- status='approved' (a replacement is authorised by the operator who queued it
-- on the service ticket; there is no second sales-side confirmation) and
-- enqueues them itself. The auto_enqueue_on_approve trigger is deliberately
-- NOT broadened to INSERT: it only fires `after update of status`, and an
-- already-approved INSERT slips past it by design, so the creation path has
-- exactly one thing that queues an order rather than two racing to.
--
-- This migration only carries the one-time data move that the UI change
-- strands. It is idempotent -- the WHERE no longer matches once it has run.
--
-- Replacements that were already stock-ready and still have a live ticket sat
-- in Sales > Replacement, which this release removes. Flipping them to
-- 'approved' fires the existing update trigger and lands them in Ready to Ship.
--
-- Deliberately NOT moved: ready replacements whose ticket is already closed
-- (6 rows when this was written). bucketOrders has hidden those from Sales
-- since the closed-ticket rule landed, and enqueueing them now would resurrect
-- months-old orders into Ready to Ship. They stay visible in
-- Fulfillment > Replacements, which is where a stranded replacement belongs.
update public.orders o
set status = 'approved'
where o.kind = 'replacement'
  and o.status = 'pending'
  and o.replacement_state = 'ready'
  and o.shipped_at is null
  and o.delivered_at is null
  and exists (
    select 1 from public.service_tickets t
    where t.id = o.linked_ticket_id
      and t.status <> 'closed'
  );
