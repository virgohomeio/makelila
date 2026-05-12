-- Customer-facing forms at /return and /cancel-order on lila.vip.
--
-- Both are anonymous (no auth) — customers don't have makelila accounts.
-- We grant the anon role INSERT-only access to the relevant tables so the
-- form can submit but customers can't read other people's submissions.
--
-- Returns: extend existing public.returns. Add 'customer_phone' +
-- 'description' columns to capture the freeform context the form collects
-- and a 'source' column tagging customer-submitted vs ops-entered rows.
--
-- Order cancellations: new public.order_cancellations table with the
-- workflow CS will use after a customer requests a cancel.

-- ============================================================================
-- 1. Extend returns table
-- ============================================================================
alter table public.returns
  add column if not exists customer_phone text;
alter table public.returns
  add column if not exists description text;
alter table public.returns
  add column if not exists source text not null default 'ops'
    check (source in ('ops','customer_form'));

-- Allow anonymous inserts so the public form can submit. Anon users still
-- can't SELECT (existing returns_select is to authenticated only).
drop policy if exists "returns_insert_anon" on public.returns;
create policy "returns_insert_anon" on public.returns
  for insert to anon
  with check (source = 'customer_form' and status = 'created');

-- ============================================================================
-- 2. New order_cancellations table
-- ============================================================================
create table if not exists public.order_cancellations (
  id uuid primary key default gen_random_uuid(),
  order_ref text,                           -- '#1107' if customer knows it
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  reason text,                              -- 'Changed mind', 'Found better price', 'Delivery too slow', etc
  description text,                         -- free-text
  status text not null default 'submitted' check (status in (
    'submitted','approved','denied','completed'
  )),
  ops_notes text,
  processed_by uuid references auth.users(id),
  processed_at timestamptz,
  refund_approval_id uuid references public.refund_approvals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ordercancellations_status on public.order_cancellations (status);
create index if not exists idx_ordercancellations_orderref on public.order_cancellations (order_ref);

alter table public.order_cancellations enable row level security;

-- Anonymous users: INSERT only with default status (can't pre-approve their own)
create policy "ordercancellations_insert_anon" on public.order_cancellations
  for insert to anon
  with check (status = 'submitted');

-- Authenticated team: full access
create policy "ordercancellations_select" on public.order_cancellations
  for select to authenticated using (true);
create policy "ordercancellations_insert" on public.order_cancellations
  for insert to authenticated with check (true);
create policy "ordercancellations_update" on public.order_cancellations
  for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.order_cancellations;

create or replace function public.touch_order_cancellations_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists ordercancellations_touch on public.order_cancellations;
create trigger ordercancellations_touch before update on public.order_cancellations
  for each row execute function public.touch_order_cancellations_updated_at();
