-- Feature 3: bidirectional Linear/GitHub issue linking from Service tickets.
-- Adds link columns so an operator can attach a Linear or GitHub issue to a
-- ticket, and a stamp column set by the inbound webhook when the issue closes.
alter table public.service_tickets
  add column if not exists linear_issue_url text,
  add column if not exists github_issue_url text,
  add column if not exists engineering_resolved_at timestamptz;
