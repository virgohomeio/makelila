-- P50 unit cost was never re-derived after the unit count was corrected.
--
-- The 2026-04-20 seed (20260420190000_stock_batches_units.sql) recorded P50 as
-- 60 units against invoice PI240726B01 for $45,000, so unit_cost_usd was set to
-- $45,000 / 60 = $750.00.
--
-- Three days later 20260420260000_p50_is_50_units.sql corrected the batch to 50
-- units: serials 51-60 had been seeded as P50 but belong to P150. It fixed
-- unit_count but left unit_cost_usd at $750, so the per-unit figure has been
-- carrying the old 60-unit divisor ever since.
--
-- The serial space confirms 50 is right and that nothing is double-counted:
--   P50   1-50    (50 rows)   P150  51-200  (150 rows, = its own 150-unit invoice)
--   P50N  201-250 (50 rows)   P100  251-350 (100 rows)   P100X 351-450 (100 rows)
--
-- $45,000 over 50 units is $900.00 each.
--
-- Blast radius: none today. order_actual_cogs_usd() prefers a linked unit's
-- batch cost, but no sale order links to a P50 unit (0 of 50 have
-- customer_order_ref), so no orders.cogs_usd changes. Every P50-era order is
-- costed off the roadmap schedule instead. This matters the moment a P50 unit
-- gets linked to an order.

update public.batches
   set unit_cost_usd = 900.00,
       notes = notes || ' Unit cost $900 = $45,000 invoice / 50 units '
                     || '(was $750, a stale 60-unit divisor; corrected 2026-08-28).'
 where id = 'P50'
   and unit_count = 50
   and total_cost_usd = 45000.00;

-- Re-cost any sale order that would now pick up the corrected figure.
select * from public.apply_sale_cogs_schedule();
