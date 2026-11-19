-- orders.shipping_cost_usd is not USD.
--
-- The column has carried Canadian dollars since it was populated. Its own
-- backfill migration (20260605040000) documents the sources as CAD in its
-- header — "$XX.XX CAD" string-format prices from the MaxxUs sheet, and a
-- "flat $60 CAD" for personal deliveries — while the column it wrote them into
-- is named `_usd` and the operator-facing input in the Fulfillment queue is
-- labelled "Actual shipping cost (USD)". Same column, two claimed currencies.
--
-- Verified before writing this migration (2026-08-06): all 70 populated rows
-- match the backfill's values exactly — 0 diverged, 0 from any other source. So
-- every value currently in the column is CAD, and no operator has yet entered a
-- figure through the USD-labelled input. Relabelling is therefore safe now and
-- gets less safe every day it waits.
--
-- The column is NOT renamed here. `shipping_cost_usd` is referenced by
-- lib/orders.ts, the v_customer_shipping_costs / v_customer_shipping_summary
-- views, the Customers lifetime-cost work and the Finance module's projection
-- queries; renaming it is a wider change than this fix warrants. Instead the
-- currency becomes explicit alongside it, and every reader is expected to
-- consult it rather than trust the column name.
--
-- Anything summing this column as USD is wrong for all 70 rows today. That
-- includes the planned Finance lifetime-cost rollups (docs/feature-backlog
-- -alpha-feedback.md #55 / customer lifetime cost).

alter table public.orders
  add column if not exists shipping_cost_currency text;

-- Every existing value came from the CAD backfill — established by exact-value
-- comparison against 20260605040000, not by assumption.
update public.orders
   set shipping_cost_currency = 'CAD'
 where shipping_cost_usd is not null
   and shipping_cost_currency is null;

alter table public.orders
  add constraint orders_shipping_cost_currency_present
  check (shipping_cost_usd is null or shipping_cost_currency is not null)
  not valid;

-- `not valid` skips the retroactive scan but enforces the rule on every future
-- write, so a cost can never again be stored without saying what currency it is.
alter table public.orders validate constraint orders_shipping_cost_currency_present;

comment on column public.orders.shipping_cost_usd is
  'Actual carrier/label cost. MISNAMED — despite the _usd suffix the currency is whatever shipping_cost_currency says, and every row populated to date is CAD. Never sum this column without grouping by shipping_cost_currency.';
comment on column public.orders.shipping_cost_currency is
  'ISO code for shipping_cost_usd. Required whenever that column is non-null.';
