-- Backlog #57 — Raymond's temporary backfill flow.
-- Add columns so historical shipments (units that already shipped via the
-- Google Sheets process, before makelila was the system of record) can be
-- paired with an order in the app without losing their 'shipped' status.
-- Distinguishing backfill from live shipment matters for reporting:
-- backfilled rows don't have real label cost, real ship-date precision,
-- or full pipeline audit trail.

alter table public.units
  add column if not exists backfilled_at timestamptz,
  add column if not exists backfill_source text;

create index if not exists units_backfilled_at_idx
  on public.units(backfilled_at) where backfilled_at is not null;
