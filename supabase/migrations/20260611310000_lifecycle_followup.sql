-- #87: Post-onboarding follow-up email
-- Add tracking column so we can surface "Send follow-up" once per completed onboarding.
ALTER TABLE customer_lifecycle ADD COLUMN IF NOT EXISTS followup_email_sent_at TIMESTAMPTZ;

-- Seed the default follow-up template. Variables: customer_first_name, bullet_1, bullet_2, bullet_3.
-- Guarded with NOT EXISTS so re-running this migration is safe even without a unique constraint.
INSERT INTO email_templates (id, key, name, category, description, subject, body, variables, channel, active)
SELECT
  gen_random_uuid(),
  'post_onboarding_followup',
  'Post-Onboarding Follow-Up',
  'support',
  'Sent manually after a completed onboarding call to share first-week tips.',
  'Your LILA onboarding — quick follow-up',
  'Hi {{customer_first_name}},

Thanks for joining us for your LILA onboarding session! We''re so glad you''re up and running.

Here are a few things to keep in mind in your first few weeks:

• {{bullet_1}}
• {{bullet_2}}
• {{bullet_3}}

If anything comes up, just reply to this email — we''re always happy to help.

Best,
The LILA Team',
  ARRAY['customer_first_name', 'bullet_1', 'bullet_2', 'bullet_3'],
  'email',
  true
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE key = 'post_onboarding_followup');
