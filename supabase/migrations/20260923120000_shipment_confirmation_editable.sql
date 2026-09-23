-- Shipment-confirmation email: two booking links + operator-editable body
--
-- Until now the Step-5 email body lived hardcoded in TWO places that had to be
-- kept in sync by hand: the preview in Fulfillment/queue/StepEmail.tsx and the
-- real send in the send-fulfillment-email edge function. The
-- 'shipment_confirmation' row seeded by 20260421170000_email_templates.sql was
-- written to mirror them but nothing ever read it.
--
-- This migration makes that row the single source of truth. The edge function
-- now renders it, the preview renders it, and an operator can edit it — either
-- for one send, or permanently via "Save as default" in Step 5 / the Templates
-- module. Editing the copy no longer needs a deploy.
--
-- Two content changes ship with it:
--   1. The onboarding link is split in two. https://calendly.com/lila-ed was
--      a bare profile URL, not an event type. It is replaced by the weekday
--      intro call and the off-hours session so the customer self-selects.
--   2. {{starter_block}} is now a declared variable. It carries the US-only
--      Amazon starter-kit tracking lines and is empty on every CA order — both
--      renderers strip this one placeholder when blank (every other missing
--      variable still renders visibly as {{name}} so gaps are obvious).
--
-- The booking URLs are literal text in the body, not variables, so changing a
-- Calendly link later is a Templates edit rather than a code change.

update public.email_templates
set
  description =
    'Sent when Step 5 (Send email) is confirmed in the Fulfillment Queue. '
    'Rendered by the send-fulfillment-email edge function; operators can edit '
    'a single send in Step 5 or save their edit back here as the new default.',
  subject = 'Your LILA has officially shipped! 🎉 ({{order_ref}})',
  body =
'Hi {{customer_first_name}},

Your LILA has officially shipped! 🎉 It''s on its way to you. Here are your shipping details:

Carrier: {{carrier}}

Tracking Number: {{tracking_num}}

Tracking Link: {{tracking_url}}
{{starter_block}}
You can use the link above to check on your delivery progress at any time.

Important next steps

1. Mandatory onboarding session
Once your unit arrives, you''ll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.

Book a weekday session (business hours):
https://calendly.com/lila-ed/intro-call

Evenings or weekends work better? Book here:
https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik

2. Please keep the original box
Please do not throw out the original packaging for the first 30 days after delivery. In the rare event of shipping damage or if a return is required during our 30-day refund period, the unit must be returned in its original box.

Thank you again for being part of the LILA community and supporting our mission to make composting effortless and sustainable. We can''t wait to see the difference your LILA will make in your home.

Happy Composting! 🌱
-The VCycene Team',
  variables = array[
    'customer_first_name','order_ref','carrier','tracking_num',
    'tracking_url','starter_block'
  ],
  active = true
where key = 'shipment_confirmation';

-- The edge function hard-errors when this row is missing rather than sending
-- stale hardcoded copy, so make sure it exists on databases seeded before the
-- template library landed.
insert into public.email_templates (key, name, category, description, subject, body, variables)
select
  'shipment_confirmation', 'LILA has shipped', 'fulfillment',
  'Sent when Step 5 (Send email) is confirmed in the Fulfillment Queue.',
  'Your LILA has officially shipped! 🎉 ({{order_ref}})',
  'Hi {{customer_first_name}},

Your LILA has officially shipped! 🎉

Tracking Link: {{tracking_url}}
{{starter_block}}
Book a weekday session (business hours):
https://calendly.com/lila-ed/intro-call

Evenings or weekends work better? Book here:
https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik

Happy Composting! 🌱
-The VCycene Team',
  array['customer_first_name','order_ref','carrier','tracking_num','tracking_url','starter_block']
where not exists (
  select 1 from public.email_templates where key = 'shipment_confirmation'
);
