-- Per-operator scheduling link (Calendly / Google Appointments / whatever the
-- operator books through).
--
-- The Hiring module's screening invite renders {{scheduling_url}} per candidate
-- and, until now, left a "[paste Calendly link here]" marker for the operator to
-- fill in by hand on every single draft. This column holds the link once, on the
-- operator's own profile, so every draft they generate from here on resolves it
-- automatically. It is deliberately per-operator, not global: each interviewer
-- books on their own calendar.
--
-- Column ACL: 20260605140000 revoked blanket UPDATE on profiles from
-- `authenticated` and re-granted display_name only, so a new column is NOT
-- client-writable until it is explicitly granted. Grants are additive per
-- column, so this leaves the display_name grant (and the still-ungranted
-- role / is_internal / id columns) exactly as they are. RLS
-- "profiles_update_self" already constrains the write to the operator's own
-- row, which is the whole point here.

alter table public.profiles add column if not exists scheduling_url text;

comment on column public.profiles.scheduling_url is
  'Operator''s own booking link. Fills {{scheduling_url}} in email templates they draft.';

grant update (scheduling_url) on public.profiles to authenticated;
