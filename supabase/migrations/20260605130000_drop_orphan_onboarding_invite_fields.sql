-- Drop orphan columns left by a discarded .ics-invite approach to #44.
-- The shipped auto-invite uses Google Calendar co-host + reina_invited_at
-- (see sync-calendly-events), so calendly_event_end / onboarding_invite_sent_at
-- and their partial index are unused. Removing them clears DB-vs-repo drift.

drop index if exists public.service_tickets_pending_invite_idx;

alter table public.service_tickets
  drop column if exists calendly_event_end,
  drop column if exists onboarding_invite_sent_at;
