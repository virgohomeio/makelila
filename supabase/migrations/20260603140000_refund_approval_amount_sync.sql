-- BUG fix: refund_approvals rows auto-created from customer-form returns
-- ended up with refund_amount_usd = 0 because returns.refund_amount_usd is
-- backfilled AFTER the trigger fires (ReturnForm insert is bare-bones; the
-- amount is computed/imported later). Two fixes:
--   1. One-shot backfill for the 2 known cases (Phayvanh + Brent).
--   2. Trigger so future amount-set on a return propagates to its approval,
--      but only while the approval is still in manager_review (don't
--      clobber operator-set amounts in finance_review/refunded states).

-- 1. Backfill.
update public.refund_approvals ra
   set refund_amount_usd = r.refund_amount_usd,
       updated_at = now()
  from public.returns r
 where ra.return_id = r.id
   and (ra.refund_amount_usd is null or ra.refund_amount_usd = 0)
   and coalesce(r.refund_amount_usd, 0) > 0;

-- 2. Sync trigger. Only acts when the approval is still in the earliest
-- review stage; once finance touches it, the value is considered curated
-- and we leave it alone.
create or replace function public.sync_refund_approval_amount()
returns trigger language plpgsql as $$
begin
  if new.refund_amount_usd is distinct from old.refund_amount_usd
     and coalesce(new.refund_amount_usd, 0) > 0 then
    update public.refund_approvals
       set refund_amount_usd = new.refund_amount_usd,
           updated_at = now()
     where return_id = new.id
       and status = 'manager_review'
       and (refund_amount_usd is null or refund_amount_usd = 0);
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_refund_approval_amount on public.returns;
create trigger trg_sync_refund_approval_amount
  after update of refund_amount_usd on public.returns
  for each row
  execute function public.sync_refund_approval_amount();
