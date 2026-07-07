-- Add the 'refund_queue' stage between finance_review and refunded. Finance
-- approving the amount now moves the case to 'refund_queue' (approved, awaiting
-- payout); the operator executes the payout and marks it 'refunded'.

alter table public.refund_approvals
  drop constraint if exists refund_approvals_status_check;

alter table public.refund_approvals
  add constraint refund_approvals_status_check
  check (status in (
    'submitted','manager_review','finance_review','refund_queue','refunded','denied','closed'
  ));
