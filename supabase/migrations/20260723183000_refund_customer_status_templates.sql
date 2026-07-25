-- FR-15 (Refund & Return Approval PRD §7): standardized, automated status
-- messages to the CUSTOMER at each refund transition (application received →
-- approved → processing → funds sent). Distinct from the internal FR-9 executor/
-- AM notifications. Fired best-effort from the refund mutation functions; the
-- Templates module lets operators edit the copy. (Applied to prod via MCP.)

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'refund_application_received_customer',
  'Refund — application received (customer)',
  'returns_refunds',
  'FR-15: sent to the customer when their refund request is logged (submitToManager/compile).',
  'We''ve received your LILA refund request',
  E'Hi {{customer_first_name}},\n\nThanks — we''ve received your refund request for {{amount}} and it''s now with our team for review. We''ll be in touch as it moves forward, and you don''t need to do anything else for now.\n\nThank you,\nThe VCycene / LILA team',
  array['customer_first_name','amount'],
  'email',
  true
),
(
  'refund_approved_customer',
  'Refund — approved (customer)',
  'returns_refunds',
  'FR-15: sent to the customer when the Return Manager approves the refund.',
  'Your LILA refund has been approved',
  E'Hi {{customer_first_name}},\n\nGood news — your refund of {{amount}} has been approved. It''s now with our finance team to process the payment. We''ll let you know once the funds are on their way.\n\nThank you,\nThe VCycene / LILA team',
  array['customer_first_name','amount'],
  'email',
  true
),
(
  'refund_processing_customer',
  'Refund — processing (customer)',
  'returns_refunds',
  'FR-15: sent to the customer when finance queues the refund for payout.',
  'Your LILA refund is being processed',
  E'Hi {{customer_first_name}},\n\nYour refund of {{amount}} is now being processed via {{method}}. Depending on your payment provider it can take a few business days to appear. We''ll confirm once it''s been sent.\n\nThank you,\nThe VCycene / LILA team',
  array['customer_first_name','amount','method'],
  'email',
  true
),
(
  'refund_funds_sent_customer',
  'Refund — funds sent (customer)',
  'returns_refunds',
  'FR-15: sent to the customer when the payout is executed.',
  'Your LILA refund has been sent',
  E'Hi {{customer_first_name}},\n\nYour refund of {{amount}} has been sent via {{method}}. Please allow a few business days for it to land in your account. If you don''t see it after that, just reply to this email and we''ll look into it right away.\n\nThank you,\nThe VCycene / LILA team',
  array['customer_first_name','amount','method'],
  'email',
  true
)
on conflict (key) do nothing;
