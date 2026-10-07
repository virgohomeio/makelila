-- supabase/migrations/20260723130000_refund_reminder_digest.sql
--
-- FR-9 (c) (Refund & Return Approval PRD): reminder digests for the ACTION
-- queues only — Manager Review, Financial Review, Refund Queue (cadence decided
-- Jul 22). If a card is still in the same action queue 3 days after entering it,
-- the responsible person gets a summary email of everything still open for them,
-- repeating every 3 days until the card moves on. Stages that legitimately wait
-- on the customer or a physical return (Completeness, Return & Inspection) are
-- excluded — those are covered by BR-16.
--
-- Implemented by the send-refund-reminders edge function, on a daily pg_cron.
-- The 3-day cadence + anti-respam is enforced in the function via
-- last_reminded_at; the timer resets naturally when a card enters a new stage
-- (the function keys "days in stage" off the per-stage entry timestamp).

alter table public.refund_approvals
  add column last_reminded_at timestamptz null;

comment on column public.refund_approvals.last_reminded_at is
  'FR-9c: when the last reminder digest that included this card was sent. Used to throttle reminders to a 3-day cadence.';

-- Operator-editable digest template. {{refund_summary}} is a pre-rendered,
-- multi-line list of the recipient''s overdue cards, built by the edge function.
insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'refund_reminder_digest',
  'Refunds waiting on you',
  'returns_refunds',
  'Reminder digest to a role-holder listing refunds that have sat in their action queue (Manager Review / Financial Review / Refund Queue) for 3+ days.',
  'Refunds waiting on you — {{count}} open',
  E'Hi {{recipient_first_name}},\n\nThese refunds have been sitting in your queue for 3+ days and need action:\n\n{{refund_summary}}\n\nOpen the refund board: {{refund_url}}\n\n— makeLILA',
  array['recipient_first_name','count','refund_summary','refund_url']::text[],
  'email',
  true
)
on conflict (key) do nothing;

-- Daily at 14:00 UTC (~9-10am ET). The function itself enforces the 3-day
-- cadence, so a daily trigger simply gives each overdue card a chance to remind
-- as soon as it crosses the threshold. Mirrors the invoke_edge_function bridge
-- used by the other crons.
select cron.schedule(
  'send-refund-reminders',
  '0 14 * * *',
  $$ select public.invoke_edge_function('send-refund-reminders'); $$
);
