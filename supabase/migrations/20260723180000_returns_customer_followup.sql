-- BR-16 (Refund & Return Approval PRD §5.5, v0.2): stale-card handling for
-- returns awaiting a customer response. A return sitting in the "Return Form
-- Submitted" (Intake / New) stage must not stall silently — after 7 days we
-- auto-remind the customer, and after 14 days the card is flagged for
-- escalation/closure. These columns back the `send-return-followups` edge
-- function and the "awaiting customer, day X" indicator on the Refunds board.

alter table public.returns
  add column if not exists last_customer_reminder_at timestamptz,
  add column if not exists followup_escalated_at      timestamptz;

comment on column public.returns.last_customer_reminder_at is
  'BR-16: when we last auto-reminded the customer about this pending return (re-nudge cadence gate).';
comment on column public.returns.followup_escalated_at is
  'BR-16: set once the return has awaited the customer past the escalation interval (default 14 days).';

-- Customer-facing follow-up template (distinct from the internal FR-9 executor
-- emails). Rendered by send-return-followups and sent via Resend.
insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values (
  'return_followup_customer',
  'Return follow-up — nudge the customer (BR-16)',
  'returns_refunds',
  'BR-16: auto-reminder to a customer whose return has awaited their action for 7+ days.',
  'Following up on your LILA return',
  E'Hi {{customer_first_name}},\n\nWe wanted to follow up on your return request. It has been about {{days_waiting}} days and we haven''t yet received what we need to move it forward.\n\nIf you''d still like to proceed, just reply to this email (or reach us on your usual support channel) and we''ll help you finish it. If your plans have changed, let us know and we''ll close it out.\n\nThank you,\nThe VCycene / LILA team',
  array['customer_first_name','days_waiting'],
  'email',
  true
)
on conflict (key) do nothing;
