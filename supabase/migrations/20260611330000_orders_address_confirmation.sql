-- #84: Customer address confirmation via email link
-- address_confirmed_at: set when customer clicks the confirm link (via confirm-address edge fn)
-- address_confirmation_sent_at: set when the confirmation email is dispatched (via cron)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_confirmation_sent_at TIMESTAMPTZ;

-- Template for the outbound confirmation email.
-- Cron-sent (active=false so it doesn't appear as operator-sendable).
-- Variables: customer_first_name, order_ref, confirm_url
INSERT INTO email_templates (id, key, name, category, description, subject, body, variables, channel, active)
SELECT
  gen_random_uuid(),
  'address_confirmation',
  'Address Confirmation',
  'order_review',
  'Auto-sent to new orders asking the customer to confirm their shipping address. Triggered by cron.',
  'Quick check on your LILA shipping address',
  E'Hi {{customer_first_name}},\n\nThanks for your LILA order ({{order_ref}})!\n\nBefore we ship, we''d like you to confirm your delivery address is correct:\n\n  {{address_line}}\n  {{city}}, {{region_state}} {{postal}}\n  {{country}}\n\nIf this looks right, just click the link below:\n\n  {{confirm_url}}\n\nIf something looks off, please reply to this email and we''ll sort it out before your unit ships.\n\nBest,\nThe LILA Team',
  ARRAY['customer_first_name', 'order_ref', 'address_line', 'city', 'region_state', 'postal', 'country', 'confirm_url'],
  'email',
  false
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE key = 'address_confirmation');
