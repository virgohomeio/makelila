-- supabase/migrations/20261007120000_sale_confirmed_template.sql
--
-- Tell Reina every time Sales confirms a sale.
--
-- Asked for by Reina (reina@virgohome.io) 2026-10-07. Confirming an order in
-- Order Review is the hand-off into fulfillment — the UPDATE fires
-- auto_enqueue_approved_order, which puts the order in the queue with a
-- 2-day SLA clock running — and nothing announced it. Customer Service only
-- found out a sale had been confirmed by opening the queue and noticing a new
-- row, so an order could sit a day before anyone downstream knew it existed.
--
-- Sent by lib/orders.ts notifySaleConfirmed() through the existing
-- send-template-email edge function, from disposition(order, 'approved') —
-- the one write that confirms a sale, so every door into the queue knocks.
--
-- Operator-editable copy; {{snake_case}} variables. 'order_review' category
-- matches the sibling order notifications (email_templates check constraint).

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'sale_confirmed',
  'Sale confirmed — internal notice',
  'order_review',
  'Internal notification to Customer Service when Sales confirms an order in Order Review and it enters the fulfillment queue.',
  'Sale confirmed — {{order_ref}} · {{customer_name}}',
  E'Hi {{recipient_first_name}},\n\n{{confirmed_by}} just confirmed a sale in Order Review. It is now in the fulfillment queue.\n\nOrder: {{order_ref}}\nCustomer: {{customer_name}}\nTotal: {{amount}}\n\nOpen the queue: {{queue_url}}\nOpen the order: {{order_url}}\n\n— makeLILA',
  array['recipient_first_name','order_ref','customer_name','amount','confirmed_by','queue_url','order_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
