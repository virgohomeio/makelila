-- Order reconciliation — the "shipped before the app knew" backlog (2026-08-28)
--
-- 79 pending sales orders belong to a customer who already has a shipped unit,
-- with nothing tying that unit to that order: the machine went out before the
-- fulfillment queue was the route it went out through. Each one is exactly one
-- of three things — a shipment we never recorded, a duplicate of an order we
-- did record, or a genuinely open order — and no query can tell them apart,
-- because the same customer with two orders and one unit is ambiguous by
-- construction. These columns hold an operator's decision rather than a guess.
--
-- Additive and nullable throughout. Every existing row reads NULL, which means
-- "never reviewed", so nothing changes for orders nobody has looked at.

alter table public.orders
  add column if not exists reconciled_at     timestamptz null,
  add column if not exists reconciled_by     text        null,
  add column if not exists reconcile_outcome text        null,
  add column if not exists reconcile_note    text        null;

comment on column public.orders.reconcile_outcome is
  'shipped | duplicate | open — an operator''s verdict on an order that predates '
  'the fulfillment queue. NULL means never reviewed. ''open'' also overrides the '
  'shipped-customer name heuristic in bucketOrders so the order returns to the rail.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_reconcile_outcome_chk'
  ) then
    alter table public.orders
      add constraint orders_reconcile_outcome_chk
      check (reconcile_outcome is null or reconcile_outcome in ('shipped', 'duplicate', 'open'));
  end if;
end $$;

-- A queue row that reaches step 6 by reconciliation had no packer, no test
-- report and no customer email. Ops metrics read the queue as throughput, so
-- without a marker these rows read as orders that shipped the day they were
-- approved and make cycle time look better than it is.
alter table public.fulfillment_queue
  add column if not exists reconciled_at         timestamptz null,
  add column if not exists reconciliation_source text        null;

comment on column public.fulfillment_queue.reconciliation_source is
  'Set when the row was fast-forwarded to step 6 to record a shipment that '
  'happened outside the app. Exclude these rows from throughput and cycle-time '
  'reporting.';
