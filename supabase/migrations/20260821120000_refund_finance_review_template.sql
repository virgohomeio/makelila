-- supabase/migrations/20260821120000_refund_finance_review_template.sql
--
-- FR-9d: notify the Finance Officer when a refund card enters Finance Review.
--
-- Reported by Julie (yueli@virgohome.io) 2026-08-21: no email when cards land in
-- her column. Confirmed against prod — of the refund flow's stage moves, every
-- one but this had an internal notice:
--   finance_review → refund_queue : refund_queued_executor  (FR-9a)  ✓
--   refund_queue   → refunded     : refund_executed_am      (FR-9b)  ✓
--   manager_review → finance_review :        (nothing)              ✗
-- The only thing that had ever emailed her was send-refund-reminders, the 3-day
-- *overdue* digest (4 sends, all 2026-07-24..29), which by design stays quiet
-- until a card is already late — so a card approved by the manager sat silent
-- for up to four days. Two cards were in exactly that state when this was filed.
--
-- Sent by lib/postShipment.ts notifyFinanceReviewEntry() via the existing
-- send-template-email edge function, from both doors into the column
-- (managerApprove and sendRefundBack → finance_review).
--
-- Operator-editable copy; {{snake_case}} variables. 'returns_refunds' category
-- matches the sibling refund notifications (email_templates check constraint).

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'refund_finance_review',
  'Refund awaiting Finance Review',
  'returns_refunds',
  'Internal notification to the Finance Officer when a refund card enters the Finance Review column — on manager approval, or when the executor sends a card back from the Refund Queue.',
  'Refund awaiting your review — {{customer_name}} ({{amount}})',
  E'Hi {{finance_first_name}},\n\nA refund has been approved by the Return Manager and is now in the Finance Review column, waiting on you to confirm the amount and choose the refund method.\n\nCustomer: {{customer_name}}\nAmount: {{amount}}\n\nReview it here: {{refund_url}}\n\n— makeLILA',
  array['finance_first_name','customer_name','amount','refund_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
