-- P1 #3: Seed built-in email/SMS templates.
-- Uses ON CONFLICT (key) DO NOTHING so re-running is safe and operator
-- edits to existing templates are preserved.

INSERT INTO email_templates (key, name, category, description, subject, body, variables, channel, active)
VALUES

-- ── Order Review ─────────────────────────────────────────────────────────────

('missing_contact_info', 'Missing Contact Info', 'order_review',
 'Sent when an order is missing a phone number or email address.',
 'We need your contact info — LILA Order {{order_ref}}',
 E'Hi {{customer_name}},\n\nWe received your LILA Composter order ({{order_ref}}) but are missing some contact information needed to process your shipment.\n\nCould you please reply with:\n{{missing_fields}}\n\nThis will help us keep you updated on your order and arrange delivery.\n\nThanks,\nLILA Team',
 ARRAY['order_ref', 'customer_name', 'missing_fields'],
 'email', true),

('address_verification', 'Address Verification', 'order_review',
 'Sent when an address mismatch is detected (e.g. postal code vs city).',
 'Please confirm your shipping address — LILA Order {{order_ref}}',
 E'Hi {{customer_name}},\n\nWe noticed a possible discrepancy with the shipping address on your LILA order ({{order_ref}}) and want to make sure your composter arrives at the right place.\n\nAddress on file:\n{{address_on_file}}\n\nSuggested correction:\n{{address_suggested}}\n\nPlease reply to confirm which address is correct, or provide an updated address.\n\nThanks,\nLILA Team',
 ARRAY['order_ref', 'customer_name', 'address_on_file', 'address_suggested'],
 'email', true),

-- ── Returns / Refunds ────────────────────────────────────────────────────────

('return_label', 'Return Label', 'returns_refunds',
 'Sent to the customer with their prepaid return shipping label.',
 'Your LILA return label — Order {{order_ref}}',
 E'Hi {{customer_name}},\n\nWe''ve processed your return request for order {{order_ref}}. Please find your prepaid return shipping label attached.\n\nInstructions:\n1. Pack your LILA Composter securely in its original packaging if possible.\n2. Attach the label to the outside of the box.\n3. Drop it off at any {{carrier}} location by {{return_deadline}}.\n\nOnce we receive your unit, we''ll process your {{return_outcome}} within 3–5 business days.\n\nTracking: {{return_tracking}}\n\nThank you,\nLILA Team',
 ARRAY['order_ref', 'customer_name', 'carrier', 'return_deadline', 'return_outcome', 'return_tracking'],
 'email', true),

-- ── Replacements ─────────────────────────────────────────────────────────────

('replacement_shipped', 'Replacement Shipped', 'replacements',
 'Sent when a replacement order has been shipped.',
 'Your replacement LILA is on its way — Ref {{replacement_ref}}',
 E'Hi {{customer_name}},\n\nGreat news — your replacement LILA Composter has shipped!\n\nReplacement ref: {{replacement_ref}}\nCarrier: {{carrier}}\nTracking: {{tracking_number}}\nEstimated delivery: {{estimated_delivery}}\n\nYou can track your shipment here: {{tracking_url}}\n\nIf you have any questions, just reply to this email.\n\nWarm regards,\nLILA Team',
 ARRAY['replacement_ref', 'customer_name', 'carrier', 'tracking_number', 'estimated_delivery', 'tracking_url'],
 'email', true),

-- ── Support ───────────────────────────────────────────────────────────────────

('status_update', 'Status Update', 'support',
 'General-purpose status update email for any service ticket or order.',
 'Update on your LILA request — {{ticket_ref}}',
 E'Hi {{customer_name}},\n\nWe wanted to give you a quick update on your request ({{ticket_ref}}).\n\n{{status_message}}\n\nNext steps: {{next_steps}}\n\nExpected resolution: {{expected_resolution}}\n\nThank you for your patience. Please don''t hesitate to reply if you have any questions.\n\nBest,\nLILA Team',
 ARRAY['ticket_ref', 'customer_name', 'status_message', 'next_steps', 'expected_resolution'],
 'email', true),

-- ── SMS variants ─────────────────────────────────────────────────────────────

('missing_contact_info_sms', 'Missing Contact Info (SMS)', 'order_review',
 'SMS fallback for customers with no email on file.',
 '',
 'Hi {{customer_name}}, we need your {{missing_fields}} to complete your LILA order {{order_ref}}. Please reply or email support@lilacomposter.com. Thank you!',
 ARRAY['order_ref', 'customer_name', 'missing_fields'],
 'sms', true),

('replacement_shipped_sms', 'Replacement Shipped (SMS)', 'replacements',
 'SMS notification that a replacement unit has shipped.',
 '',
 'Your replacement LILA shipped! Track: {{tracking_url}}. Questions? Reply here or email support@lilacomposter.com.',
 ARRAY['tracking_url'],
 'sms', true),

('status_update_sms', 'Status Update (SMS)', 'support',
 'Brief SMS status update for a service ticket.',
 '',
 'Hi {{customer_name}}, update on your LILA request {{ticket_ref}}: {{status_message}}. Reply or email support@lilacomposter.com.',
 ARRAY['ticket_ref', 'customer_name', 'status_message'],
 'sms', true)

ON CONFLICT (key) DO NOTHING;
