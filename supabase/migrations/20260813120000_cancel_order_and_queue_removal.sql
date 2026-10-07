-- Two operator actions in the Fulfillment > Queue header (beside the Due pill):
--
--   "Cancel Order"                             the order is dead — it leaves the
--                                              queue AND every Sales > Orders tab
--   "Shipment Not Ready — Move Back to Orders" the shipment isn't happening yet —
--                                              the order leaves the queue and goes
--                                              back to Sales > Orders
--
-- Both delete the fulfillment_queue row, which RLS did not permit until now, and
-- the first needs a terminal state on orders that isn't one of the four review
-- dispositions.

-- ---------------------------------------------------------------------------
-- 1. orders.status gains 'cancelled'
-- ---------------------------------------------------------------------------
-- Terminal: a cancelled order is filtered out of Order Review's Pending / Held /
-- Flagged / Confirmed / Replacement tabs and can't be re-enqueued (the
-- auto_enqueue_on_approve trigger only fires on a transition INTO 'approved', so
-- re-approving from the DB is the deliberate way back). The row itself is kept —
-- finance still needs the order's totals, and customer_profitability already
-- discounts replacement rows with status = 'cancelled'.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending', 'approved', 'flagged', 'held', 'cancelled'));

comment on column public.orders.status is
  'Order Review disposition: pending (untriaged) | approved (in fulfillment) | '
  'flagged | held, plus the terminal cancelled. Cancelled orders are hidden from '
  'every Order Review tab and have no fulfillment_queue row.';

-- Provenance for the cancel. dispositioned_by/at is the review-decision audit and
-- is stamped too, but these two answer "why is this order dead" without a join
-- onto activity_log.
alter table public.orders add column if not exists cancelled_at timestamptz;
alter table public.orders add column if not exists cancelled_reason text;

comment on column public.orders.cancelled_reason is
  'Operator-typed reason captured when the order was cancelled. Null unless status = ''cancelled''.';

-- ---------------------------------------------------------------------------
-- 2. fulfillment_queue: allow internal users to DELETE
-- ---------------------------------------------------------------------------
-- Until now the table only had select/insert/update policies, so a delete
-- silently affected 0 rows. Both header actions remove the row outright rather
-- than parking it in a tombstone state: the queue is "what is being shipped
-- right now", and unique(order_id) means a re-approval re-inserts a clean row.
drop policy if exists "fulfillment_queue_delete" on public.fulfillment_queue;
create policy "fulfillment_queue_delete" on public.fulfillment_queue
  for delete to authenticated
  using (public.is_internal_user());
