-- Rural / remote addresses need a person before Sales can confirm
--
-- Sales already classified these orders two independent ways — area_type
-- 'rural' (Canada Post's FSA rule, the remote-prefix list, the verify-address
-- model, or an operator's override) and address_verdict 'remote' (USPS record
-- type R, or an RR / general-delivery / concession match on the street line) —
-- and then confirmed them exactly like a downtown house. A grey "Rural" tag on
-- the rail row and an amber line in the pre-confirm summary asked nobody for
-- anything.
--
-- A rural delivery is the one that most needs a human: the carrier may not
-- serve the address at all, the extended-area surcharge can dwarf the base
-- rate, and a pallet on a rural route usually needs an arrangement agreed with
-- the customer (terminal pickup, a delivery appointment, a tail-lift) before
-- the label is bought.
--
-- So these two columns become a fourth confirm criterion, the same shape as
-- sales_confirmed_fit: a classifier found something, and a named person signs
-- off before it ships. NULL means nobody has looked — which is why there is no
-- default and no backfill. Every order already classified rural gets the
-- blocker the next time someone opens it, which is the point.
--
-- The app treats a MISSING column (this migration unapplied) as a
-- non-blocking warning, so pushing the frontend ahead of this file cannot
-- strand a rural order. Once it is applied, NULL blocks.

alter table public.orders
  add column if not exists rural_check_confirmed_at timestamptz,
  add column if not exists rural_check_confirmed_by uuid;

comment on column public.orders.rural_check_confirmed_at is
  'When an operator signed off the manual check a rural/remote delivery needs '
  '(carrier serves the address, surcharge accepted, any delivery arrangement '
  'agreed with the customer). NULL = nobody has checked; the fourth Sales '
  'confirm criterion blocks until it is set. Written by '
  'setRuralCheckConfirmed() in app/src/lib/orders.ts.';

comment on column public.orders.rural_check_confirmed_by is
  'Who signed off the rural/remote manual check (auth.users id, same shape as '
  'dispositioned_by). Cleared together with rural_check_confirmed_at.';
