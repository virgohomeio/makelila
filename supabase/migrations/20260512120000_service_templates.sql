-- Three new email templates for the Service module, added to the existing
-- 18-template library. Variables follow the {{snake_case}} convention
-- rendered by send-template-email edge function and renderTemplate() in
-- app/src/lib/templates.ts.

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
  (
    'onboarding_calendly_confirmation',
    'Onboarding — Calendly confirmation',
    'support',
    'Sent automatically when a customer schedules an onboarding call. Confirms the booked time and provides the meeting link.',
    'Your LILA Pro onboarding call is confirmed',
    'Hi {{customer_first_name}},

Your LILA Pro onboarding call is booked for {{event_start_local}} ({{event_timezone}}).

Meeting link: {{event_url}}
Host: {{host_name}}

We''ll walk you through unboxing, first run, daily use, and answer any questions you have. Please have your unit (serial: {{unit_serial}}) plugged in and ready before the call.

If you need to reschedule, use the link above.

Talk soon,
The VCycene team',
    array['customer_first_name','event_start_local','event_timezone','event_url','host_name','unit_serial'],
    'email',
    true
  ),
  (
    'onboarding_followup_check_in',
    'Onboarding — Follow-up check-in',
    'support',
    'Sent after onboarding is marked complete. Asks how things are going and invites questions.',
    'How''s your LILA Pro running?',
    'Hi {{customer_first_name}},

It''s been a few days since your onboarding call — we wanted to check in.

How is your LILA Pro running? Any questions or quirks we can help with?

A few common things people ask about in week one:
  • First-cycle smell — normal as the heater seasons; clears in 2-3 cycles
  • Cycle time — runs 4-8 hours depending on load and moisture
  • What goes in — see our quick reference: https://lilacomposter.com/guides

Just reply to this email if anything''s off. We''re here.

Best,
The VCycene team',
    array['customer_first_name'],
    'email',
    true
  ),
  (
    'warranty_expired_quote',
    'Warranty — Out-of-warranty quote',
    'support',
    'Suggested send when a support/repair ticket arrives for a unit whose warranty has lapsed. Politely informs customer and offers a paid repair quote.',
    'About your LILA Pro service request',
    'Hi {{customer_first_name}},

Thank you for reaching out about your LILA Pro (serial: {{unit_serial}}).

We checked your records — this unit shipped on {{shipped_date}}, which puts it {{months_out_of_warranty}} months past our standard 12-month warranty.

We can still service it. A typical out-of-warranty repair runs $150-$400 depending on the issue (parts + labor + return shipping). If you''d like to proceed, reply to this email and we''ll send a firm quote within 2 business days after a quick diagnosis.

Best,
The VCycene team',
    array['customer_first_name','unit_serial','shipped_date','months_out_of_warranty'],
    'email',
    true
  )
on conflict (key) do nothing;
