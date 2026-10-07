-- Open the refund workflow to everyone involved (not only managers).
--
-- Previously refund_approvals UPDATE required is_manager(), which blocked the
-- Account Manager (operator role) from submitting a case, editing the amount,
-- moving a card between columns, or sending it back. Per product direction, all
-- internal users involved in the workflow may do these; the tab is already
-- internal-only and every action is still attributed (activity_log + *_by
-- fields).
--
-- NOTE: this loosens a deliberate RBAC control, so it is a human-approved change
-- (the automated guard blocks an agent from applying it). Apply it via the
-- Supabase SQL editor or the gated migration workflow.

drop policy if exists refundapprovals_update on public.refund_approvals;
create policy refundapprovals_update on public.refund_approvals
  for update using (public.is_internal_user()) with check (public.is_internal_user());

-- Allow removing a refund request ("uncompile" → the case returns to Return &
-- Inspection). No delete policy existed, so this was impossible before.
drop policy if exists refundapprovals_delete on public.refund_approvals;
create policy refundapprovals_delete on public.refund_approvals
  for delete using (public.is_internal_user());
