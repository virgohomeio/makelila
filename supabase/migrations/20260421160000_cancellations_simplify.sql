-- Cancellations can't be denied (every customer request is accepted as
-- intent — ops just processes the refund if money was already collected,
-- otherwise just records the cancellation). Drop the review state machine.
--
-- Before: submitted | approved | denied | completed
-- After:  submitted | completed
--
-- Any existing 'approved' or 'denied' rows are migrated:
--   approved → completed (it was already in finance flow)
--   denied   → completed (rare; treat as terminal state, ops can re-open
--                          via direct DB edit if needed)

update public.order_cancellations
   set status = 'completed'
 where status in ('approved', 'denied');

alter table public.order_cancellations
  drop constraint if exists order_cancellations_status_check;
alter table public.order_cancellations
  add constraint order_cancellations_status_check
  check (status in ('submitted', 'completed'));
