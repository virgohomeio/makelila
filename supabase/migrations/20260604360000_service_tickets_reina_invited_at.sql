-- Backlog #44 — auto-invite Reina to every customer onboarding call when
-- one is scheduled in Calendly. The sync-calendly-events edge function
-- uses this column to dedupe so the cron doesn't re-invite on every run.
-- NULL = not yet invited; timestamp = when the invite was sent.

alter table public.service_tickets
  add column if not exists reina_invited_at timestamptz;

comment on column public.service_tickets.reina_invited_at is
  'Backlog #44: set when sync-calendly-events fires a Google Calendar invite for the onboarding co-host. NULL until the invite is sent.';
