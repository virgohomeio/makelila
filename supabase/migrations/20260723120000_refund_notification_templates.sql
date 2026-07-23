-- supabase/migrations/20260723120000_refund_notification_templates.sql
--
-- FR-9 (Refund & Return Approval PRD): replace the manual WeChat hand-offs with
-- system email notifications (channel decided Jul 22 = email). Two event
-- notifications seeded here, rendered + sent by the existing send-template-email
-- edge function (same path as the ticket_assigned template):
--   * refund_queued_executor — fires when Finance approves a refund into the
--     Refund Queue; goes to the executor (Shopify/Sezzle → payments operator,
--     everything else → finance officer).
--   * refund_executed_am — fires when the payout is executed; goes back to the
--     Account Manager (the case owner) so they can tell the customer.
--
-- Operator-editable copy; {{snake_case}} variables. Filed under the
-- 'returns_refunds' category (allowed by email_templates' check constraint).

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'refund_queued_executor',
  'Refund ready to execute',
  'returns_refunds',
  'Internal notification to the payout executor when Finance approves a refund into the Refund Queue.',
  'Refund ready to execute — {{customer_name}} ({{amount}})',
  E'Hi {{executor_first_name}},\n\nA refund has been approved and is now in the Refund Queue for you to execute.\n\nCustomer: {{customer_name}}\nAmount: {{amount}}\nMethod: {{method}}\n\nProcess it here: {{refund_url}}\n\n— makeLILA',
  array['executor_first_name','customer_name','amount','method','refund_url']::text[],
  'email',
  true
),
(
  'refund_executed_am',
  'Refund processed — notify the customer',
  'returns_refunds',
  'Internal notification back to the Account Manager (case owner) when a refund payout has been executed, so they can confirm with the customer.',
  'Refund processed — {{customer_name}} ({{amount}})',
  E'Hi {{am_first_name}},\n\nThe refund for {{customer_name}} has been executed ({{amount}} via {{method}}). Please let the customer know the funds are on the way and confirm receipt.\n\nCase: {{refund_url}}\n\n— makeLILA',
  array['am_first_name','customer_name','amount','method','refund_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
