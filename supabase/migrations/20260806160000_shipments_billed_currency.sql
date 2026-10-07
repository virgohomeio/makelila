-- Shipment cost: record the currency Freightcom actually billed in.
--
-- `billed_cad` was being written from whatever number the invoice carried, with
-- no check on the currency field that comes with it. Freightcom returns money as
-- { value: "<cents>", currency: "CAD" | "USD" } — freightcom-quote already reads
-- that pair and splits rate_cad / rate_usd, but sync-freightcom-shipments divided
-- by 100 and wrote the result into a *_cad column regardless. A US-bound shipment
-- billed in USD would land in the Rate (CAD) column as though it were Canadian
-- dollars, silently overstating nothing and understating the real CAD cost by the
-- FX spread.
--
-- After this migration the split is explicit:
--   billed_amount   — the invoiced total in its native currency
--   billed_currency — that currency ('CAD', 'USD', …)
--   billed_cad      — populated ONLY when billed_currency = 'CAD'
--
-- so "Rate (CAD)" on the Shipping dashboard means literally that, and a non-CAD
-- invoice renders with its own currency label instead of masquerading as CAD.

alter table public.shipments
  add column if not exists billed_amount   numeric(12,2),
  add column if not exists billed_currency text;

comment on column public.shipments.billed_cad is
  'Invoiced total in CAD. Null when Freightcom billed in another currency — see billed_amount/billed_currency.';
comment on column public.shipments.billed_amount is
  'Invoiced total in its native currency, whatever that is.';
comment on column public.shipments.billed_currency is
  'ISO code Freightcom invoiced in. CAD for essentially all VCycene shipments; USD appears on some cross-border lanes.';

-- Existing rows: all 38 predate any successful API sync (they were hand-loaded
-- from a Freightcom tracking-dashboard export that carried no cost column), so
-- billed_cad is null across the board and there is nothing to backfill. The
-- backfill happens on the first live sync run, per shipment id.
