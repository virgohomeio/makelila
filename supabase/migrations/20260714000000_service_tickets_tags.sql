-- Multi-select status tags on service tickets.
--
-- Separate from the single workflow `status` column (which still drives SLA
-- aging, closed_at, the state machine, and replacement side-effects). Tags are
-- purely for labelling and reuse the ticket status vocabulary; stored as a
-- free-form text[] so the label set can extend without a constraint migration.
ALTER TABLE service_tickets
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
