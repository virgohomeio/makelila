-- Fix: public return-form submissions failing with "new row violates row-level
-- security policy for table refund_approvals".
--
-- The customer return form runs as the anon role. Inserting a `returns` row
-- fires returns_auto_refund -> auto_create_refund_for_customer_return(), which
-- inserts into refund_approvals (the Finance approval queue, #85). That function
-- was SECURITY INVOKER, so the refund_approvals insert ran as anon — which has
-- no INSERT policy on refund_approvals — and the whole submission rolled back.
--
-- Mark the trigger function SECURITY DEFINER (pinned search_path) so it creates
-- the internal approval row on the customer's behalf. The customer never writes
-- refund_approvals directly; only this trigger does.
create or replace function public.auto_create_refund_for_customer_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
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
end $function$;
