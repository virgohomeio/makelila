-- #82: soft-delete / dedup support for customers created by Quo sync.
-- merged_into_id lets a duplicate customers row point at the canonical record
-- so future Quo syncs that re-create a duplicate immediately resolve to the
-- right customer_id instead of re-orphaning service_tickets.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES customers(id) ON DELETE SET NULL;
