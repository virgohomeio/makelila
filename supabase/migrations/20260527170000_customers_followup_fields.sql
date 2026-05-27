-- Columns to hold onboarding follow-up data imported from the operator's
-- HTML follow-up calendar (lila-follow-up-calendar.html). All nullable.
alter table public.customers
  add column if not exists onboard_date date,
  add column if not exists fu1_status   text,
  add column if not exists fu2_status   text,
  add column if not exists fu_notes     text;
