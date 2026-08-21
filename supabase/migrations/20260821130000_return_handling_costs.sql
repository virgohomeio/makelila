-- Return handling cost — what it costs VCycene to take a unit back.
--
-- Profitability charged the refund and (in principle) the freight, but nothing
-- for the work of receiving, shelving and inspecting a returned machine. A
-- customer who sent a unit back looked, on the cost side, like one who kept it.
--
-- NOT the same thing as refund_approvals.restocking_fee_usd. That is a $50 fee
-- CHARGED TO THE CUSTOMER and deducted from their payout by computeRefundNet
-- (waived for genuine defects, BR-7); it has been applied to 9 approvals for
-- $450 total. It is money VCycene keeps. This migration adds money VCycene
-- SPENDS. The two must not be netted against each other — they are opposite
-- signs on different ledgers that happen to share a name and, per the operator
-- (Huayi, 2026-08-21), the same $50 figure, on the theory that the fee was
-- originally sized to recover the true cost.
--
-- ── What counts as "came back" ─────────────────────────────────────────────
-- Only returns where the unit physically arrived:
--     status in (received, inspected, refunded, closed)
--     and disposition is not 'discard'
--
-- disposition='discard' and status='discarded' both mean the CUSTOMER binned
-- the unit and nothing shipped — RefundsTab compiles those straight to
-- Completeness, "skipping Return & Inspection". No freight, no stocking, no
-- inspection. On today's data that excludes 3 discarded and 2 not-yet-shipped
-- returns, leaving 46 of 51.
--
-- ── The three components ───────────────────────────────────────────────────
--   stocking    $50 flat per returned unit.
--   inspection  1 hour per unit at the blended person-hour rate already in
--               support_rates — one dial governs all internal labour, so
--               changing the rate moves diagnosis calls and inspections
--               together rather than letting them drift.
--   freight     the return leg. Preferred source is the operator-entered
--               returns.return_shipping_cad; failing that, the Freightcom
--               shipment whose tracking number matches returns.pickup_tracking.
--
-- ── Why freight is matched on tracking, not shipments.order_id ─────────────
-- 20260812110000 sums every shipment linked to an order, deliberately
-- including return legs. Linking the return legs there would work, but it
-- would bury them inside sale_shipping_cad where they read as outbound
-- freight. Matching on returns.pickup_tracking keeps the return leg in its own
-- bucket and, critically, avoids double-counting: these 5 shipments stay
-- order_id NULL, so they cannot be summed twice.
--
-- Only 6 of 51 returns record pickup_tracking at all, and all 27 refunded ones
-- record none — so 45 returns will show $0 freight until someone fills in
-- return_shipping_cad. That column is the manual escape hatch; it has no UI
-- yet.

alter table public.returns
  add column if not exists return_shipping_cad numeric(12,2) check (return_shipping_cad >= 0);

comment on column public.returns.return_shipping_cad is
  'Operator-entered actual cost of the return leg, CAD. Takes precedence over '
  'the Freightcom shipment matched via pickup_tracking. Only 6 of 51 returns '
  'have tracking on file, so this is how the rest get costed.';

create table if not exists public.return_cost_rates (
  key        text primary key,
  value      numeric(10,2) not null check (value >= 0),
  note       text,
  updated_at timestamptz not null default now()
);

comment on table public.return_cost_rates is
  'Flat inputs to return handling cost. Labour is NOT here — inspection is '
  'priced from support_rates so one rate governs all internal time.';

alter table public.return_cost_rates enable row level security;

drop policy if exists return_cost_rates_select on public.return_cost_rates;
create policy return_cost_rates_select on public.return_cost_rates
  for select using (public.is_internal_user());

drop policy if exists return_cost_rates_write on public.return_cost_rates;
create policy return_cost_rates_write on public.return_cost_rates
  for update using (public.is_manager());

grant select on public.return_cost_rates to authenticated;

insert into public.return_cost_rates (key, value, note) values
  ('stocking_per_unit_cad', 50.00,
   'Flat cost of taking one returned machine back into stock, CAD. Set by Huayi 2026-08-21, mirroring DEFAULT_RESTOCKING_FEE.'),
  ('inspection_hours', 1.00,
   'Person-hours to inspect one returned unit. Priced at support_rates.internal_person_hour. Set by Huayi 2026-08-21.')
on conflict (key) do nothing;
