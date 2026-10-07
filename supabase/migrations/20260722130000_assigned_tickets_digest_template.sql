-- Assigned-tickets digest — one internal email per operator summarizing how
-- many open support tickets they own. Sent by the send-assignment-digests
-- edge function (grouped by owner), not per-ticket. Filed under 'support'
-- (email_templates.category has a fixed check constraint). The {{ticket_summary}}
-- variable is pre-pluralized by the function ('1 open support ticket' /
-- 'N open support tickets').

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'assigned_tickets_digest',
  'Assigned tickets digest',
  'support',
  'Internal digest emailed to an operator summarizing the count of open support tickets currently assigned to them.',
  'Your assigned support tickets on makeLILA',
  E'Hi {{assignee_first_name}},\n\nYou have {{ticket_summary}} assigned to you on makeLILA.\n\nOpen your tickets here: {{ticket_url}}\n\n— makeLILA',
  array['assignee_first_name','ticket_summary','ticket_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
