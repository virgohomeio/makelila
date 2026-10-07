-- Add new ticket statuses (Service module, issue #7):
--   needs_outreach — we owe the customer contact
--   scheduled      — a call/visit is booked
--   on_hold        — parked for an internal/parts reason
-- Existing rows keep their current status; no backfill needed.

alter table public.service_tickets
  drop constraint if exists service_tickets_status_check;

alter table public.service_tickets
  add constraint service_tickets_status_check
  check (status in (
    'new','triaging','needs_outreach','scheduled','in_progress',
    'on_hold','waiting_customer','resolved','closed','escalated'
  ));
