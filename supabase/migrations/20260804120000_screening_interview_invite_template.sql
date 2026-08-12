-- Screening interview invite copy.
--
-- The Hiring module's Interviews board renders this per shortlisted candidate,
-- with the candidate's first name and the posting title filled in, for the
-- operator to copy into their own mail client. makeLILA does NOT send it —
-- nothing here goes through send-template-email or email_messages. The row
-- lives in email_templates so the copy stays operator-editable in the
-- Templates tab instead of being frozen in the component.
--
-- email_templates.category has a fixed check constraint with no hiring bucket,
-- so this is filed under 'support' — the same call the ticket_assigned template
-- made. Variables use the {{snake_case}} convention renderTemplate resolves.
--
-- {{scheduling_url}} is deliberately left unresolved: the board swaps it for a
-- bracketed "[paste Calendly link here]" marker, since makeLILA doesn't hold
-- the booking page and the operator pastes the link in at send time.

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'screening_interview_invite',
  'Screening interview invite',
  'support',
  'Copy for inviting a shortlisted candidate to a screening interview. Rendered per candidate on the Hiring module''s Interviews board for the operator to copy and send from their own mail client — makeLILA does not send it.',
  'Screening interview for the {{job_title}} role at VCycene',
  'Hi {{candidate_first_name}},

Thanks for applying for the {{job_title}} role at VCycene. We''ve reviewed your application and would like to set up a short screening interview.

Please pick a time that works for you here:
{{scheduling_url}}

The call runs about 30 minutes — we''ll walk through your background and the role, with time at the end for your questions. If none of the times listed work for you, just reply to this email and we''ll find another slot.

Looking forward to speaking with you.

— The VCycene Hiring Team',
  array['candidate_first_name','job_title','scheduling_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;
