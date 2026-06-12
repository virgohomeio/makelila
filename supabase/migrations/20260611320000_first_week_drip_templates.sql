-- #88: Seed first-week drip email templates as reference content for the
-- Klaviyo "First Use" flow (trigger: 'First Use' Klaviyo event fired by
-- markOnboardingComplete; Day 3 → email 1, Day 3+4=Day 7 → email 2).
-- These are NOT sent via send-template-email — they exist here so Reina
-- can review and copy content into the Klaviyo flow builder.

INSERT INTO email_templates (id, key, name, category, description, subject, body, variables, channel, active)
SELECT
  gen_random_uuid(),
  'first_week_day3',
  'First Week — Day 3 Check-in',
  'post_shipment',
  'Klaviyo drip: sent 3 days after onboarding (First Use event). Reassures customer about the first-batch timeline.',
  'Your first week with LILA — what''s normal',
  E'Hi {{customer_first_name}},\n\nYou''re a few days into your LILA journey — how''s it going?\n\nA quick heads-up on what to expect:\n\n• Your first batch takes 10–14 days. That''s completely normal — the microbes are just getting established.\n• You may notice a mild earthy smell. That''s composting happening! A strong ammonia smell just means you''ve added too much nitrogen — toss in some dry brown material.\n• Keep the lid closed as much as possible during the first batch.\n\nWe''re here if you have questions. Just reply to this email anytime.\n\nBest,\nThe LILA Team',
  ARRAY['customer_first_name'],
  'email',
  false
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE key = 'first_week_day3');

INSERT INTO email_templates (id, key, name, category, description, subject, body, variables, channel, active)
SELECT
  gen_random_uuid(),
  'first_week_day7',
  'First Week — Day 7 Update',
  'post_shipment',
  'Klaviyo drip: sent 7 days after onboarding (4 days after Day 3 email). Celebrates progress and sets expectations for batch completion.',
  'Your first batch is on its way',
  E'Hi {{customer_first_name}},\n\nA week in — you''re doing great!\n\nHere''s where things stand:\n\n• Your first batch should complete around day 10–14. You''ll know it''s ready when the material looks dark and crumbly, like rich soil.\n• Once it''s ready, use it in your garden, mix it into potting soil, or give it to a neighbor with a green thumb.\n• You can start the next batch right away — LILA is designed for continuous composting.\n\nKeep it up! Reply anytime if you have questions or just want to share a photo of your harvest.\n\nBest,\nThe LILA Team',
  ARRAY['customer_first_name'],
  'email',
  false
WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE key = 'first_week_day7');
