-- Capture shipping tracking number on units (was previously only on
-- fulfillment_queue rows, which most shipped units never had — they came
-- in via the legacy Excel flow before the app-driven 6-step queue).
-- Closes the 5/26 meeting-derived "missing tracking" pain.
alter table public.units add column if not exists tracking_num text;
create index if not exists idx_units_tracking_num on public.units (tracking_num)
  where tracking_num is not null;
