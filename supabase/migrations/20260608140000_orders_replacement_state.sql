-- Replacement tagging + pending replacements (spec 2026-06-08).
--
-- Persisted state distinguishing fulfillable replacement orders from those
-- waiting on out-of-stock parts or a pending unit batch. Drives the
-- "Replacement Orders (Ready)" vs "Awaiting Stock / Batch" split in
-- Order Review > Replacement, written at creation time by
-- createReplacementOrder ('ready') / createPendingReplacement ('awaiting').

alter table public.orders
  add column if not exists replacement_state text
    check (replacement_state in ('ready', 'awaiting'));

-- Backfill existing replacement orders:
--   awaiting  → blocked on a batch, no items captured yet, or any *_pending line
--   ready     → everything else
update public.orders o
   set replacement_state = case
     when o.awaiting_batch_id is not null then 'awaiting'
     when o.line_items = '[]'::jsonb then 'awaiting'
     when exists (
       select 1 from jsonb_array_elements(o.line_items) li
        where li->>'kind' like '%\_pending'
     ) then 'awaiting'
     else 'ready'
   end
 where o.kind = 'replacement'
   and o.replacement_state is null;
