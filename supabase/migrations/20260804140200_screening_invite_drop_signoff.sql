-- Drop the "— The VCycene Hiring Team" sign-off from the screening invite.
--
-- The invite is sent from the operator's own mail client under their own name
-- and signature, so a second, corporate sign-off reads as a mail-merge blast —
-- the opposite of the tone a screening invite wants.
--
-- Surgical regexp_replace rather than a full body rewrite: the row is
-- operator-editable in the Templates tab (that is why it lives in
-- email_templates at all), and makeLILA is the system of record for
-- operator-curated copy. Rewriting the whole body would clobber any edit made
-- since 20260804120000 landed. This only removes the trailing sign-off and the
-- blank line above it, and is a no-op if someone already removed it by hand.

update public.email_templates
   set body = regexp_replace(body, '\s*—\s*The VCycene Hiring Team\s*$', '')
 where key = 'screening_interview_invite'
   and body ~ '—\s*The VCycene Hiring Team\s*$';
