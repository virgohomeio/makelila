-- Revise unit-level columns to match how ops actually uses the Stock module.
--
-- Remove: tested boolean, tracking_num text
--   The tested boolean was a design-era placeholder — we never populate it
--   and QC pass/fail is better tracked at batch level (or in a future
--   test_logs table). tracking_num is redundant with fulfillment_queue's
--   per-shipment tracking, and the historical md snapshot doesn't have
--   tracking strings anyway.
--
-- Keep: carrier (populated from the inventory snapshot — useful context for
--   historical shipments even without a tracking number).
--
-- Add:
--   - color ('White' | 'Black'): real SKU split per batch, on every MaxxUs /
--     Canada Fulfillment / P150 delivery row in the snapshot.
--   - defect_reason: free text explanation for scrap/rework/lost units so
--     we can answer "why did this unit come back?" without cross-referencing
--     the returns log.
--   - shipped_at: timestamp of the first/most-recent shipment. Distinct from
--     status_updated_at which churns on every edit. Useful for warranty
--     window calc + cohort analysis.

alter table public.units drop column if exists tested;
alter table public.units drop column if exists tracking_num;

alter table public.units
  add column if not exists color text
    check (color is null or color in ('White','Black'));
alter table public.units
  add column if not exists defect_reason text;
alter table public.units
  add column if not exists shipped_at timestamptz;

-- Back-fill color: md flags black units via "(black)" in the notes. Default
-- the rest to White (the primary SKU). Null remains possible for units
-- where we genuinely don't know (e.g. unshipped P100X).
update public.units set color = 'Black'
  where notes ilike '%black%';

update public.units set color = 'White'
  where color is null
    and batch in ('P50','P150','P50N','P100');

-- Back-fill shipped_at for units already in 'shipped' status using the
-- status_updated_at as an approximation (close enough — the snapshot set
-- status_updated_at when it flipped status to shipped). Future status
-- changes won't clobber shipped_at so this remains a stable milestone.
update public.units set shipped_at = status_updated_at
  where status = 'shipped' and shipped_at is null;
