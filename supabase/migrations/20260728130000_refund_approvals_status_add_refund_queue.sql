-- FR-8: the 'refund_queue' stage was added to the app but never to the
-- refund_approvals.status CHECK constraint, so Finance's "Approve amount ->
-- Refund Queue" failed with "new row violates check constraint
-- refund_approvals_status_check". Recreate the constraint with the full status
-- set. (Applied to prod via MCP.)
alter table public.refund_approvals drop constraint if exists refund_approvals_status_check;
alter table public.refund_approvals add constraint refund_approvals_status_check
  check (status in ('submitted','manager_review','finance_review','refund_queue','refunded','denied','closed'));
