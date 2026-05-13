-- Email Template Library
--
-- A catalog of reusable templates for every customer-facing email send.
-- Templates have {{variable}} placeholders that the send-template-email
-- edge function resolves at send time. Each send is logged to
-- email_messages with the final rendered subject + body + Resend message id.
--
-- 18 starter templates cover every contact point in the customer journey:
--   Pre-purchase / Order Review (5)
--   Fulfillment (2)
--   Post-shipment (4)
--   Returns / Refunds / Cancellations (5)
--   Replacements (1)
--   Generic support (1)

-- ============================================================================
-- email_templates
-- ============================================================================
create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,                       -- 'return_received', 'address_mismatch', etc
  name text not null,                             -- human-readable
  category text not null check (category in (
    'order_review','fulfillment','post_shipment',
    'returns_refunds','replacements','support'
  )),
  description text,                               -- when to use this template
  subject text not null,                          -- supports {{variables}}
  body text not null,                             -- supports {{variables}}
  variables text[] not null default '{}',         -- declared placeholders for UI hints
  channel text not null default 'email' check (channel in ('email','sms')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_templates_category on public.email_templates (category);
create index if not exists idx_email_templates_active   on public.email_templates (active);

alter table public.email_templates enable row level security;
create policy "templates_select" on public.email_templates for select to authenticated using (true);
create policy "templates_update" on public.email_templates for update to authenticated using (true) with check (true);
create policy "templates_insert" on public.email_templates for insert to authenticated with check (true);
alter publication supabase_realtime add table public.email_templates;

create or replace function public.touch_email_templates() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists email_templates_touch on public.email_templates;
create trigger email_templates_touch before update on public.email_templates
  for each row execute function public.touch_email_templates();

-- ============================================================================
-- email_messages (audit log of every send)
-- ============================================================================
create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  template_key text references public.email_templates(key) on delete set null,
  recipient_email text not null,
  recipient_name text,
  subject text not null,                          -- rendered (post-substitution)
  body text not null,                             -- rendered
  variables jsonb,                                -- the values used to fill the template
  status text not null default 'queued' check (status in ('queued','sent','bounced','failed','delivered')),
  resend_id text,                                 -- Resend's message id (em_xxx)
  error text,
  related_return_id uuid references public.returns(id) on delete set null,
  related_refund_id uuid references public.refund_approvals(id) on delete set null,
  related_cancellation_id uuid references public.order_cancellations(id) on delete set null,
  sent_by uuid references auth.users(id),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_messages_template on public.email_messages (template_key);
create index if not exists idx_email_messages_recipient on public.email_messages (lower(recipient_email));
create index if not exists idx_email_messages_sent on public.email_messages (sent_at desc nulls last);

alter table public.email_messages enable row level security;
create policy "email_messages_select" on public.email_messages for select to authenticated using (true);
create policy "email_messages_insert" on public.email_messages for insert to authenticated with check (true);
create policy "email_messages_update" on public.email_messages for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.email_messages;

-- ============================================================================
-- Seed: 18 templates covering every customer contact point
-- ============================================================================
insert into public.email_templates (key, name, category, description, subject, body, variables) values

-- ===== Order Review =====
('address_confirm', 'Confirm shipping address', 'order_review',
 'Generic address confirmation before we print a label. Use when the address looks plausible but a human gut-check is warranted.',
 'Quick confirm: shipping address for {{order_ref}}',
 'Hi {{customer_first_name}},

Thanks for your LILA order ({{order_ref}})! Before we ship it out, can you confirm the shipping address below is correct?

{{address_we_have}}

If this looks right, no need to reply — we''ll ship out today. If anything needs to change, just reply with the corrected address and we''ll update before the unit leaves the warehouse.

Thanks again for choosing LILA!

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','address_we_have']
),

('address_mismatch', 'Address mismatch — side-by-side confirm', 'order_review',
 'When Google Maps standardisation returns a different ZIP/postal than what the customer entered.',
 'Quick check on your shipping address ({{order_ref}})',
 'Hi {{customer_first_name}},

We''re processing your LILA order ({{order_ref}}) and noticed two slightly different versions of the shipping address. Could you confirm which one is correct?

A) You entered:
{{address_we_have}}

B) Address verification suggests:
{{address_standardized}}

Just hit reply with "A", "B", or send a corrected address — we''ll lock it in before shipping.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','address_we_have','address_standardized']
),

('missing_phone', 'Need phone number for delivery', 'order_review',
 'Carrier needs a phone number for delivery exceptions, signature requirements, or apartment buzzer.',
 'Quick favour: phone number for your delivery ({{order_ref}})',
 'Hi {{customer_first_name}},

Thanks for your LILA order ({{order_ref}})! Before we ship out, our carrier needs a phone number in case there''s a delivery exception (no answer at the door, apartment buzzer, etc.).

Could you reply with the best number to reach you? It will only be used by the carrier for delivery coordination.

Thanks!

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref']
),

('missing_email', 'Email for delivery + onboarding', 'order_review',
 'Rare case where checkout captured no email. Usually obtained via phone follow-up.',
 'Email confirmation for your LILA order ({{order_ref}})',
 'Hi {{customer_first_name}},

We have your LILA order ({{order_ref}}) ready to ship but don''t have a confirmed email address on file. We''ll send your shipping confirmation, tracking link, and onboarding session details to this address.

If this email is correct, no action needed. Otherwise reply with the right one.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref']
),

('order_held', 'Order on hold — additional info needed', 'order_review',
 'Order has been put on hold pending additional verification or input from the customer.',
 'Brief hold on your LILA order ({{order_ref}})',
 'Hi {{customer_first_name}},

Your LILA order ({{order_ref}}) is on hold while we sort out one detail:

{{hold_reason}}

We''ll start shipping as soon as this is resolved. Just hit reply with the information above and we''ll move forward.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','hold_reason']
),

-- ===== Fulfillment =====
('shipment_confirmation', 'LILA has shipped', 'fulfillment',
 'Sent automatically when Step 5 (Send email) is confirmed in the Fulfillment Queue. Mirrors the legacy send-fulfillment-email edge function.',
 'Your LILA has officially shipped! 🎉 ({{order_ref}})',
 'Hi {{customer_first_name}},

Your LILA has officially shipped! 🎉 It''s on its way to you. Here are your shipping details:

Carrier: {{carrier}}

Tracking Number: {{tracking_num}}

Tracking Link: {{tracking_url}}

You can use the link above to check on your delivery progress at any time.

Important next steps

1. Mandatory onboarding session
Once your unit arrives, you''ll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.
Book a session here: {{calendly_url}}.

2. Please keep the original box
Please do not throw out the original packaging for the first 30 days after delivery. In the rare event of shipping damage or if a return is required during our 30-day refund period, the unit must be returned in its original box.

Thank you again for being part of the LILA community and supporting our mission to make composting effortless and sustainable. We can''t wait to see the difference your LILA will make in your home.

Happy Composting! 🌱
— The VCycene Team',
 array['customer_first_name','order_ref','carrier','tracking_num','tracking_url','calendly_url']
),

('shipment_delay', 'Order delay notification', 'fulfillment',
 'Inventory or carrier issue pushes ETA back. Set expectations + give the customer the option to cancel.',
 'A short delay on your LILA order ({{order_ref}})',
 'Hi {{customer_first_name}},

A quick update on your LILA order ({{order_ref}}): we''re running about {{delay_window}} behind schedule due to {{delay_reason}}.

New expected ship date: {{eta_date}}

If this doesn''t work for you, you can cancel for a full refund anytime before the unit ships at lila.vip/cancel-order — just include your order number.

Sorry for the inconvenience, and thank you for your patience.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','delay_window','delay_reason','eta_date']
),

-- ===== Post-shipment =====
('delivery_check_in', 'Did your LILA arrive OK?', 'post_shipment',
 'Sent ~24h after carrier reports delivery. Confirms receipt + flags any shipping damage early.',
 'Did your LILA arrive OK? ({{order_ref}})',
 'Hi {{customer_first_name}},

Our records show your LILA was delivered yesterday — we hope it arrived safely!

Quick check: please reply with any of the following if relevant:
  • All good, no issues — no need to reply!
  • Something looks damaged
  • Box arrived but something is missing
  • Other concern

If you spot any damage, take a photo of the box AND the unit before unpacking further, and reply with the photos attached. Our 30-day return window starts at delivery.

Don''t forget to book your onboarding session: {{calendly_url}}

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','calendly_url']
),

('onboarding_reminder', 'Book your onboarding session', 'post_shipment',
 'Sent 3 days after delivery if the customer hasn''t booked a Calendly slot yet.',
 'Reminder: book your LILA onboarding session',
 'Hi {{customer_first_name}},

Your LILA arrived a few days ago — congrats! 🎉

Before you run your first batch, please book your mandatory onboarding session. We''ll walk you through:
  • Initial setup and starter kit
  • What goes in (and what doesn''t)
  • Day 1 expectations
  • Tips for high-quality compost output

Book here: {{calendly_url}}

The session is short (~20 minutes) and ensures your first batch produces high-quality compost without the common first-time mistakes.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','calendly_url']
),

('onboarding_overdue', 'Haven''t had your onboarding yet?', 'post_shipment',
 'Sent 10 days after delivery if onboarding still not booked. Final nudge before we follow up by phone.',
 'Quick check-in: LILA onboarding session',
 'Hi {{customer_first_name}},

We noticed you haven''t had your onboarding session yet, and we want to make sure your first compost batch is a great one.

This 20-minute session is part of every LILA purchase and helps you skip the most common first-time mistakes. There''s no pressure — just pick a time that works:

{{calendly_url}}

If something else is going on or you''d prefer to chat by phone, just reply to this email and we''ll work it out.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','calendly_url']
),

('first_check_in_30d', '30-day check-in', 'post_shipment',
 'One-month milestone — gathers honest feedback while the experience is fresh.',
 'How is your LILA treating you? (1 month in)',
 'Hi {{customer_first_name}},

It''s been about a month since your LILA arrived — how are things going?

We''d love to hear:
  • How many batches have you run?
  • Any surprises (good or bad)?
  • Is there anything we could improve?

Just hit reply — we read every response. If anything isn''t working, we want to help sort it out.

Thank you for being part of the LILA community.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name']
),

-- ===== Returns / Refunds / Cancellations =====
('return_received', 'Return request received', 'returns_refunds',
 'Auto-acknowledgement when /return form is submitted. Confirms receipt + gives next-steps timeline.',
 'We''ve received your return request ({{return_ref}})',
 'Hi {{customer_first_name}},

We''ve received your return request. Sorry your LILA didn''t work out — we''ll do our best to make this easy.

Reference: {{return_ref}}

What happens next:
  1. Our team will review your request within 1–2 business days.
  2. If eligible, we''ll arrange pickup with our carrier — no shipping fee for product defects or shipping damage.
  3. Once we receive the unit and inspect it, we''ll process your refund within 5 business days.

If you need to add photos or context, reply to this email with the reference number above. Thank you for your patience while we work through this.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','return_ref']
),

('return_pickup_scheduled', 'Return pickup scheduled', 'returns_refunds',
 'Sent when ops confirms pickup with carrier. Provides pickup window + label info if drop-off.',
 'Pickup scheduled for your LILA return ({{return_ref}})',
 'Hi {{customer_first_name}},

We''ve scheduled the pickup of your LILA return.

Reference: {{return_ref}}
Carrier: {{carrier}}
Pickup window: {{pickup_window}}
Tracking: {{pickup_tracking}}

Please have the unit packed in its original box (or equivalent) and ready at your shipping address during the pickup window. The driver will pick it up directly — no need to be home as long as the package is accessible.

After we receive the unit and inspect it, your refund will be processed within 5 business days.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','return_ref','carrier','pickup_window','pickup_tracking']
),

('refund_processed', 'Refund processed', 'returns_refunds',
 'Sent when finance step approves and marks the refund_approval as refunded.',
 'Your LILA refund has been processed ({{refund_amount}})',
 'Hi {{customer_first_name}},

Your refund of {{refund_amount}} has been processed today.

Reference: {{return_ref}}
Payment method: {{payment_method}}

Depending on your method, you should see the funds within:
  • E-Transfer: a few minutes (check your inbox for an Interac email)
  • Credit card: 3–7 business days
  • Cheque / e-transfer to a third party: per the timeline we discussed

If you don''t see the refund within the expected window, just reply to this email and we''ll investigate immediately.

Thank you for giving LILA a try. We''d love to hear any feedback that could help us improve.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','refund_amount','return_ref','payment_method']
),

('refund_denied', 'Refund request — additional review', 'returns_refunds',
 'Sent when finance step denies a refund. Be empathetic, explain clearly, offer next steps.',
 'About your refund request ({{return_ref}})',
 'Hi {{customer_first_name}},

Thank you for your patience while we reviewed your refund request (reference {{return_ref}}).

After our team''s review, we''re unable to issue a refund at this time. Here''s why:

{{deny_reason}}

We understand this isn''t the answer you were hoping for. If you''d like to discuss this further or believe we missed important context, please reply to this email — we''ll personally take another look.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','return_ref','deny_reason']
),

('cancellation_received', 'Cancellation request received', 'returns_refunds',
 'Auto-acknowledgement when /cancel-order form is submitted.',
 'We''ve received your cancellation request ({{cancel_ref}})',
 'Hi {{customer_first_name}},

We''ve received your request to cancel order {{order_ref}}.

Reference: {{cancel_ref}}

What happens next:
  1. If your order hasn''t shipped yet, we''ll cancel it and process a full refund within 1–2 business days.
  2. If your order has already shipped, we''ll get in touch about the return process.

We''ll respond to you via {{preferred_contact}} as soon as we''ve reviewed your request.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','cancel_ref','preferred_contact']
),

('cancellation_processed', 'Order cancelled', 'returns_refunds',
 'Sent when ops marks the cancellation as processed.',
 'Your order has been cancelled ({{order_ref}})',
 'Hi {{customer_first_name}},

Your order {{order_ref}} has been cancelled.

{{refund_note}}

We''re sorry to see you go. If anything changes or you have feedback that would help us improve, just reply — we read every message.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','refund_note']
),

-- ===== Replacements =====
('replacement_shipped', 'Replacement on the way', 'replacements',
 'Sent when a replacement unit (or part) ships out from the Replacement Queue.',
 'Your replacement is on the way ({{order_ref}})',
 'Hi {{customer_first_name}},

Your replacement {{item_description}} is on the way.

Carrier: {{carrier}}
Tracking Number: {{tracking_num}}
Tracking Link: {{tracking_url}}

If this is a replacement unit (not a part), please:
  • Set up the new unit using the same onboarding instructions
  • Have the original unit ready for pickup — we''ll send pickup details separately

Reply to this email if anything is unclear. Sorry again for the trouble — we''re glad to be making this right.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','order_ref','item_description','carrier','tracking_num','tracking_url']
),

-- ===== Generic support =====
('support_reply', 'General support reply (blank slate)', 'support',
 'Empty template with the brand header and signature, for one-off responses that don''t fit another template.',
 '{{subject_line}}',
 'Hi {{customer_first_name}},

{{message_body}}

If anything is unclear or you have more questions, just hit reply.

— The VCycene Team
support@lilacomposter.com',
 array['customer_first_name','subject_line','message_body']
)

on conflict (key) do nothing;
