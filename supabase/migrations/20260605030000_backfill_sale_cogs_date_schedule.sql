-- Backlog #58 V3 — Sale-order COGS backfill, date-windowed.
--
-- Source: V-SAX fundraising roadmap (vcycene-fundraising-roadmap-20260605.html,
-- BenLiang OEM Partnership — COGS Roadmap table).
--
-- Per-unit COGS schedule, keyed off orders.created_at:
--
--   < 2026-06-01     →  $658   P100X and all prior prototypes (P50, P150, P50N, P100).
--                                Doc baseline cost; supersedes the $659 placeholder
--                                from the previous backfill (20260605020000).
--   2026-06 .. 07    →  $410   P500 Part 2 (gearbox/motor redesign).
--   2026-08 .. 2027-06 → $380  P500 Part 3 and follow-on production through the
--                                end-2026 target ($380 VC / $420 BL — using VC cost).
--   2027-07 .. 11    →  $320   Mid-2027 target (volume pricing + BOM optimization).
--   2027-12 onward   →  $300   End-2027 target (54% reduction from baseline).
--
-- The schedule is computed from orders.created_at (when the order landed), not
-- the batch the unit shipped from — most sale orders aren't linked to a unit
-- (only 5 of 81 today, per the units.customer_order_ref join). When the
-- order→unit link gets backfilled later, a follow-up migration can refine
-- this using the actual batch.
--
-- Idempotency / scope:
--   • Touches kind='sale' only — replacement orders' cogs is set at order-
--     creation via the #55 flow.
--   • Overwrites when cogs matches a prior backfill value (659.00 or 1318.00)
--     OR is null. Manually-entered cogs is preserved.
--   • Safe to replay any number of times — same created_at → same cogs.

with per_order as (
  select
    o.order_ref,
    o.created_at,
    coalesce(sum((li->>'qty')::int), 1) as units,
    case
      when o.created_at <  '2026-06-01' then 658.00
      when o.created_at <  '2026-08-01' then 410.00
      when o.created_at <  '2027-07-01' then 380.00
      when o.created_at <  '2027-12-01' then 320.00
      else                                   300.00
    end as per_unit_cogs
  from public.orders o
  left join lateral jsonb_array_elements(o.line_items) li on true
  where o.kind = 'sale'
  group by o.order_ref, o.created_at
)
update public.orders o
set cogs_usd = (p.units * p.per_unit_cogs)::numeric(12,2)
from per_order p
where o.order_ref = p.order_ref
  and o.kind = 'sale'
  and (
    o.cogs_usd is null
    or o.cogs_usd in (659.00, 1318.00)  -- previous backfill values
  );
