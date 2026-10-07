-- supabase/migrations/20260722140000_customers_purchaser_link.sql
--
-- FR-6 (Refund & Return Approval PRD): distinguish the CUSTOMER (purchaser of
-- record, the accounting entity) from the USER (the person we talk to / who
-- submits the refund form). Today the single `customers` table conflates them,
-- causing accounting errors and double-refund risk on gifts / household
-- accounts (Lily Xu billed to Annie Wu; RJ submitting for Katrina; Sarah vs
-- Chad Lockhart).
--
-- Model (per OQ-6 decision, 2026-07-22): self-referential link on the existing
-- table rather than a separate `users` table. Every person stays one customers
-- row. A row that represents a USER acting for someone else points at the
-- PURCHASER's row via purchaser_id. NULL = the row is its own purchaser.
-- Resolve the accounting entity as: purchaser_id (if set) else id.

alter table public.customers
  add column purchaser_id uuid null references public.customers(id) on delete set null;

-- A row may not be its own purchaser (would make resolution ambiguous).
alter table public.customers
  add constraint customers_purchaser_not_self check (purchaser_id is null or purchaser_id <> id);

-- Reverse lookup: "who are the users linked to this purchaser?" (Customers tab).
create index customers_purchaser_id_idx
  on public.customers (purchaser_id)
  where purchaser_id is not null;

comment on column public.customers.purchaser_id is
  'FR-6: when set, this row is a USER acting for the purchaser at customers.purchaser_id; refunds/accounting resolve to the purchaser. NULL = this row is its own purchaser.';
