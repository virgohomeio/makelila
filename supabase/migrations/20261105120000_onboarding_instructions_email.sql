-- Fulfillment emails split in two (2026-11-05).
--
-- The shipping email (send-fulfillment-email) now carries only shipping,
-- tracking and the signature requirement, and is sent right after "Pickup
-- scheduled" (step 4). The Lovely App sign-in + mandatory onboarding-call
-- instructions go in a second email ("ACTION NEEDED: Onboarding Instructions
-- for your LILA") sent automatically one day later by the
-- send-onboarding-instructions edge function, along with a Quo text.
--
-- send-fulfillment-email stamps onboarding_email_due_at = send + 24h (sales
-- only). Rows shipped before this have no due time and are never emailed.

alter table public.fulfillment_queue
  add column if not exists onboarding_email_due_at   timestamptz,
  add column if not exists onboarding_email_sent_at  timestamptz,
  add column if not exists onboarding_email_attempts integer not null default 0,
  add column if not exists onboarding_email_error    text;

create index if not exists fulfillment_queue_onboarding_due_idx
  on public.fulfillment_queue (onboarding_email_due_at)
  where onboarding_email_sent_at is null and onboarding_email_due_at is not null;

-- Hourly, so "one day later" is within the hour.
select cron.unschedule(jobid) from cron.job where jobname = 'send-onboarding-instructions';
select cron.schedule(
  'send-onboarding-instructions',
  '15 * * * *',
  $$ select public.invoke_edge_function('send-onboarding-instructions', '{}'::jsonb) $$
);
