-- Backlog #71 V1 — first-class "awaiting inbound batch" state on orders.
-- Replacement orders queued for an inbound batch (e.g. Kristen Pimentel's
-- R-0001 needs a P100X unit, but the batch is in production in China —
-- expected end of July) today have no visible signal beyond empty
-- line_items + a free-text note on batches.notes. Operators can't filter
-- the Replacement queue by "what's waiting on which batch" and customers
-- get vague replies. Add an explicit FK so the UI can render
-- "Awaiting P100X · expected late July" inline.

alter table public.orders
  add column if not exists awaiting_batch_id text references public.batches(id) on delete set null;

create index if not exists orders_awaiting_batch_idx
  on public.orders(awaiting_batch_id) where awaiting_batch_id is not null;

-- Mark Kristen Pimentel's R-0001 explicitly. The order is otherwise valid
-- (status=pending, linked_ticket_id set, customer/address populated).
update public.orders
   set awaiting_batch_id = 'P100X'
 where order_ref = 'R-0001';
