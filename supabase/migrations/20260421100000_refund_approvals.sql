-- Refund Approval workflow per 2026-04 Pedrum review.
--
-- CJM design (separate from returns):
--   submitted (CS just filed it)
--     → manager_review (waiting for George)
--     → finance_review (George approved, waiting for Julie)
--     → refunded (Julie processed payment)
--     → denied (rejected at any stage; capture which stage in denied_at_stage)
--     → closed (archived)
--
-- Why a separate table from public.returns:
--   - A return is the physical-logistics row (pickup → received → inspected).
--   - A refund approval is the financial-workflow row (dual sign-off,
--     timestamped audit trail). Decoupling lets a return have zero refunds
--     (we kept the unit) or multiple refunds (partial refund + later
--     goodwill credit) without contorting the returns state machine.
--
-- Future-proof: order_id is also nullable so we can ship a goodwill credit
-- that isn't tied to a return at all.

create table if not exists public.refund_approvals (
  id uuid primary key default gen_random_uuid(),
  return_id uuid references public.returns(id) on delete restrict,
  order_id  uuid references public.orders(id)  on delete set null,
  customer_name text not null,
  customer_email text,
  refund_amount_usd numeric(10,2) not null check (refund_amount_usd >= 0),
  currency text not null default 'USD',
  payment_method text,        -- 'Stripe refund' | 'Shopify refund' | 'cheque' | 'e-transfer' | …
  reason text,                -- one-line summary
  notes text,                 -- longer free-text
  status text not null default 'submitted' check (status in (
    'submitted','manager_review','finance_review','refunded','denied','closed'
  )),

  -- Audit trail per stage
  submitted_by         uuid references auth.users(id),
  submitted_at         timestamptz not null default now(),

  manager_approved_by  uuid references auth.users(id),
  manager_approved_at  timestamptz,
  manager_decision_note text,

  finance_approved_by  uuid references auth.users(id),
  finance_approved_at  timestamptz,
  finance_decision_note text,

  refunded_at          timestamptz,
  denied_by            uuid references auth.users(id),
  denied_at            timestamptz,
  denied_at_stage      text,                                  -- 'manager_review' | 'finance_review'
  denied_reason        text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_refundapprovals_status   on public.refund_approvals (status);
create index if not exists idx_refundapprovals_return   on public.refund_approvals (return_id);
create index if not exists idx_refundapprovals_order    on public.refund_approvals (order_id);

alter table public.refund_approvals enable row level security;
create policy "refundapprovals_select" on public.refund_approvals for select to authenticated using (true);
create policy "refundapprovals_insert" on public.refund_approvals for insert to authenticated with check (true);
create policy "refundapprovals_update" on public.refund_approvals for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.refund_approvals;

create or replace function public.touch_refund_approvals_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists refundapprovals_touch on public.refund_approvals;
create trigger refundapprovals_touch before update on public.refund_approvals
  for each row execute function public.touch_refund_approvals_updated_at();

-- ============================================================================
-- Convenience: when a refund is created from an existing return, auto-fill
-- customer fields from the return row if the caller didn't supply them.
-- ============================================================================
create or replace function public.fill_refund_from_return() returns trigger language plpgsql as $$
declare r record;
begin
  if new.return_id is null then return new; end if;
  if new.customer_name is not null and new.customer_email is not null then return new; end if;
  select customer_name, customer_email
    into r
    from public.returns
   where id = new.return_id;
  if found then
    new.customer_name  := coalesce(new.customer_name,  r.customer_name);
    new.customer_email := coalesce(new.customer_email, r.customer_email);
  end if;
  return new;
end $$;

drop trigger if exists refundapprovals_fill_from_return on public.refund_approvals;
create trigger refundapprovals_fill_from_return
  before insert on public.refund_approvals
  for each row execute function public.fill_refund_from_return();
