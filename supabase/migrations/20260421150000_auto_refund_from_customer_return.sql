-- Auto-promote customer-submitted return forms into the refund approval
-- pipeline so they appear in the Refunds Kanban's Manager-review column
-- immediately upon submission.
--
-- Triggered AFTER INSERT on public.returns where source='customer_form'.
-- Skips if a refund_approval already exists for that return_id (idempotent
-- for re-runs).
--
-- Refund amount defaults to 0 — manager sets the actual amount during
-- review based on order total + condition adjustments.

create or replace function public.auto_create_refund_for_customer_return()
returns trigger language plpgsql as $$
begin
  if new.source is null or new.source <> 'customer_form' then
    return new;
  end if;

  if exists (select 1 from public.refund_approvals where return_id = new.id) then
    return new;
  end if;

  insert into public.refund_approvals (
    return_id,
    customer_name,
    customer_email,
    refund_amount_usd,
    payment_method,
    reason,
    notes,
    status
  ) values (
    new.id,
    new.customer_name,
    new.customer_email,
    coalesce(new.refund_amount_usd, 0),
    new.refund_method_preference,
    new.reason,
    'Auto-created from customer-form return submission. Manager: review return form details below and set refund amount.',
    'manager_review'
  );

  return new;
end $$;

drop trigger if exists returns_auto_refund on public.returns;
create trigger returns_auto_refund
  after insert on public.returns
  for each row execute function public.auto_create_refund_for_customer_return();

-- ============================================================================
-- One-off: back-fill Ron Russell's refund_approval (his return was inserted
-- before this trigger existed). Idempotent thanks to the not-exists guard.
-- ============================================================================
insert into public.refund_approvals (
  return_id,
  customer_name,
  customer_email,
  refund_amount_usd,
  currency,
  payment_method,
  reason,
  notes,
  status
)
select
  r.id,
  r.customer_name,
  r.customer_email,
  1049,                                            -- LILA Pro list price; manager confirms during review
  'USD',
  r.refund_method_preference,
  r.reason,
  'Customer-form submission CRT-44511. Ron requested callback at 604-834-4451 for credit-card refund processing. Manager: confirm currency (CAD vs USD) and adjusted amount.',
  'manager_review'
from public.returns r
where r.source = 'customer_form'
  and r.customer_email = 'ron@newcmi.ca'
  and r.original_order_ref = '#1239'
  and not exists (select 1 from public.refund_approvals where return_id = r.id);
