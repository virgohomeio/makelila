-- Let the building type carry a third provenance: 'model'.
--
-- uspsData is US-only. Outside the US, Google's Address Validation resolves a
-- Canadian house to PREMISE and stops — it says the building exists, never what
-- kind of building it is. So dwellingFromValidation() returns null for most of
-- our orders (the customer base is majority Canadian) and the verdict falls
-- back to the sync-time regex over the street line, which is the guess the
-- 20260910153257 migration exists to stop presenting as an answer.
--
-- verify-address already runs a model pass on every address to classify the
-- delivery area. It now names the building in the same call. That reading is
-- evidence — weaker than a postal authority's record, stronger than a regex —
-- and gets its own source value rather than being laundered into 'google' or
-- hidden inside 'sync-guess'. Precedence, weakest to strongest:
--
--   sync-guess  <  model  <  google  <  manual
--
-- No backfill: every existing row keeps the provenance it already has.
alter table public.orders drop constraint if exists orders_address_verdict_source_check;
alter table public.orders add constraint orders_address_verdict_source_check
  check (address_verdict_source in ('sync-guess','model','google','manual'));
