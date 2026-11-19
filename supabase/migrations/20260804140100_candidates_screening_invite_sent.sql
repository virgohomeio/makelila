-- Screening-invite outreach tracking on the Interviews board.
--
-- The invite is drafted in makeLILA but sent from the operator's own mail
-- client (Outlook), so nothing downstream — no Resend webhook, no
-- email_messages row — can tell us whether a shortlisted candidate has
-- actually been contacted. Without a marker the board gives no answer to
-- "who still needs an email?", which is exactly the question an operator
-- working a shortlist asks. Two columns answer it.
--
-- Semantics: set when the operator opens the mail draft from the board, and
-- manually settable/clearable from the outreach panel for invites sent some
-- other way (or drafts abandoned). It records "we consider this candidate
-- contacted", not a delivery receipt — the UI labels it that way.
--
-- No new RLS: the existing candidates_update policy (20260724140000) already
-- scopes writes to can_view_posting(posting_id), and candidates carries no
-- column-level ACL restriction.

alter table public.candidates
  add column if not exists screening_invite_sent_at timestamptz,
  add column if not exists screening_invite_sent_by uuid references auth.users(id);

comment on column public.candidates.screening_invite_sent_at is
  'When an operator marked the screening invite as sent (mail draft opened, or set by hand). Not a delivery receipt.';

-- Partial index: the outreach panel's "still needs an email" query filters on
-- this being null across the shortlist, and the shortlist is the small side.
create index if not exists idx_candidates_invite_unsent
  on public.candidates (posting_id)
  where screening_invite_sent_at is null;
