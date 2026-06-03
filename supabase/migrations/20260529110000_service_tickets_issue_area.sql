-- Walkthrough #38: add a coarser "issue area" classification for reporting.
-- Different from the existing `topic` (auto-classified, fine-grained) — this
-- is operator-set, used for "how many electrical / mechanical / shipping
-- issues this month" volume reporting. Nullable, no check constraint so the
-- canonical list can iterate without a migration each time.
alter table public.service_tickets
  add column if not exists issue_area text;

create index if not exists idx_tickets_issue_area
  on public.service_tickets (issue_area)
  where issue_area is not null;
