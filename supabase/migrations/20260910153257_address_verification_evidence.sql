-- Address verification: record the EVIDENCE, not just the answer.
--
-- The address card told an operator three things — postal match, dwelling
-- type, area type — and only the first was ever actually verified:
--
--   * address_verdict was a regex over address_line run once at Shopify-sync
--     time. It ignored address_line2, which is where Shopify puts the unit
--     number, so 280 of 287 orders read 'house' — including a 4th-floor unit
--     in a Bay Harbor Islands tower (#1209, address_line2 = '4N'), #21 on Bute
--     St in downtown Vancouver (#1050, #1022) and 'Suite 102' in Chesapeake
--     (#1055). Nothing in verify-address ever revisited it.
--
--   * area_type came from a heuristic whose last line was `return 'suburban'`,
--     and the 20260616 backfill below wrote the same default into every
--     non-rural row. ~200 orders say 'Suburban' with source 'auto', which the
--     UI rendered as "auto-guess" — indistinguishable, at a glance, from the
--     real per-address classification the verify step produces.
--
-- This migration gives each claim a provenance and stores the Google/USPS
-- signals behind it, so the card can show a checked fact differently from a
-- starting guess, and so an unclassified field stays visibly unclassified.

-- ── Dwelling type ──────────────────────────────────────────────────────

-- Widen the verdict beyond the original four. USPS distinguishes a firm and a
-- PO box from a dwelling, and both change how a pallet-sized composter is
-- delivered: a business has receiving hours, a PO box cannot accept freight at
-- all.
alter table public.orders drop constraint if exists orders_address_verdict_check;
alter table public.orders add constraint orders_address_verdict_check
  check (address_verdict in ('house','apt','remote','condo','business','po_box'));

-- Where the dwelling verdict came from. 'sync-guess' is the weakest and is the
-- correct value for every existing row: a text match on what the customer
-- typed, checked against nothing. The card must not present it as confirmed.
alter table public.orders
  add column if not exists address_verdict_source text not null default 'sync-guess'
    check (address_verdict_source in ('sync-guess','google','manual'));

-- ── Missing unit number ────────────────────────────────────────────────

-- 'missing' means the street address is confirmed but the building has units
-- and this order names none — USPS dpvConfirmation 'D', or 'subpremise' in
-- Google's missingComponentTypes outside the US. A freight driver with no unit
-- number leaves the pallet in a lobby or returns it to the terminal, so this
-- flags the order the same way a postal mismatch does.
alter table public.orders
  add column if not exists address_unit_status text
    check (address_unit_status is null
           or address_unit_status in ('ok','missing','unrecognized','not_required','unknown'));

-- ── Raw validation signals ─────────────────────────────────────────────
-- Kept so a verdict can be explained after the fact and so a change in
-- Google's classification is auditable rather than silent.

alter table public.orders
  add column if not exists address_validation_granularity text;
alter table public.orders
  add column if not exists address_usps_dpv text;
alter table public.orders
  add column if not exists address_usps_record_type text;
alter table public.orders
  add column if not exists address_is_residential boolean;
alter table public.orders
  add column if not exists address_is_business boolean;

-- Why an area-type classification did not happen on the last verify (model
-- unavailable, quota, a parse failure). The classification step is a soft
-- fallback, and a soft fallback that fails silently is how a field ends up
-- looking classified when nothing classified it.
alter table public.orders
  add column if not exists address_area_type_error text;

-- ── Correct the manufactured 'suburban' ────────────────────────────────
--
-- Clear only rows whose value is the literal fallthrough default, still marked
-- 'auto'. A 'verified' value came from a real per-address classification and a
-- 'manual' value is an operator's own call — both are left alone, as are all
-- 'rural' values, which the Canada-Post FSA rule genuinely establishes.
--
-- These orders become visibly Unclassified, which is what they always were.
update public.orders
   set area_type = null
 where area_type = 'suburban'
   and area_type_source = 'auto';

comment on column public.orders.address_verdict is
  'Dwelling type. Read together with address_verdict_source: ''sync-guess'' is an unverified text guess, ''google'' is confirmed by the Address Validation API, ''manual'' is an operator override.';
comment on column public.orders.area_type is
  'Urban/suburban/rural. NULL means unclassified — never backfill a default here; see address_verdict_source''s sibling area_type_source for provenance.';
comment on column public.orders.address_unit_status is
  '''missing'' = multi-unit building with no unit number on the order; blocks a clean freight delivery.';

-- Applied to the live project on 2026-09-10 as version 20260910153257; this
-- filename matches that recorded version so `supabase db push` sees no drift.
