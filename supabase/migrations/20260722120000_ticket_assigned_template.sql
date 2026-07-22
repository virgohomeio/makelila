-- Ticket-owner assignment notification.
--
-- When a support ticket is (re)assigned to an operator who isn't the person
-- making the change, makeLILA emails the new owner via the existing
-- send-template-email edge function. This seeds the operator-editable copy.
--
-- Internal notification (recipient is a VCycene operator, not a customer), but
-- email_templates.category has a fixed check constraint, so we file it under
-- 'support' — the closest existing bucket. Variables use the {{snake_case}}
-- convention rendered by send-template-email.

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'ticket_assigned',
  'Ticket assigned to you',
  'support',
  'Internal notification sent to an operator when a support ticket is assigned to them by someone else (skipped on self-assignment).',
  'A support ticket was assigned to you — {{ticket_number}}',
  E'Hi {{assignee_first_name}},\n\n{{assigned_by}} assigned a support ticket to you on makeLILA.\n\nTicket: {{ticket_number}}\nSubject: {{subject}}\nCustomer: {{customer_name}}\n\nOpen it here: {{ticket_url}}\n\n— makeLILA',
  array['assignee_first_name','ticket_number','subject','customer_name','assigned_by','ticket_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
