-- Backlog #58 V5 — fill sale COGS, prefer ACTUAL batch cost, and keep it filled.
--
-- Three defects in the V3 backfill (20260605030000):
--
--   1. It was a one-shot UPDATE. Nothing has set orders.cogs_usd since it ran
--      on 2026-06-05, so every order that landed afterwards has a NULL COGS —
--      130 of 211 sale orders (62%) as of 2026-08-12. Customers → Profitability
--      therefore showed $0.00 COGS for most customers and overstated net margin
--      by the entire cost of goods.
--
--   2. It keyed the schedule off orders.created_at, which is when the row landed
--      in makelila, not when the customer ordered. Harmless while orders synced
--      live, but the 2026-07-23 historical Shopify import brought in 29 orders
--      PLACED in 2023-2025 whose created_at is the import date. Under created_at
--      keying those prototype-era orders price at the mid-2026 $410 tier instead
--      of the $658 baseline.
--
--   3. It used the roadmap PROJECTION for every order. The V3 migration comment
--      called this out as temporary: "most sale orders aren't linked to a unit
--      (only 5 of 81 today) ... when the order→unit link gets backfilled later,
--      a follow-up migration can refine this using the actual batch." That link
--      now covers 75 of 211 sale orders, and batches.unit_cost_usd carries the
--      real invoiced landed cost:
--
--          P50    $750.00      P150   $345.28
--          P50N   $314.00      P100   $314.00
--          P100X  (not costed yet)    LILA-Mini (not costed yet)
--
--      Those differ from the flat $658 projection by up to 2x in both
--      directions, so an order that shipped a P50N unit was overstating COGS by
--      $344 and a P50 unit understating it by $92.
--
-- Fix: cost each sale order from the actual batch of the unit that shipped
-- against it; fall back to the date-keyed roadmap schedule when no unit is
-- linked or its batch has no invoiced cost. Record which basis was used so the
-- UI can distinguish measured cost from modelled cost. Apply via a trigger so
-- new orders are costed on arrival instead of drifting until the next backfill.
--
-- Per-unit fallback schedule (USD — source: V-SAX fundraising roadmap,
-- BenLiang OEM Partnership COGS Roadmap table):
--
--   < 2026-06-01       →  $658   P100X and all prior prototypes
--   2026-06 .. 07      →  $410   P500 Part 2 (gearbox/motor redesign)
--   2026-08 .. 2027-06 →  $380   P500 Part 3 and follow-on production
--   2027-07 .. 11      →  $320   Mid-2027 target
--   2027-12 onward     →  $300   End-2027 target
--
-- CURRENCY: cogs_usd is genuinely USD — both the roadmap schedule and
-- batches.unit_cost_usd are quoted in USD regardless of the order's own
-- currency. This is NOT true of its sibling columns: total_usd/tax_usd are in
-- orders.currency, and shipping_cost_usd is CAD (see shipping_cost_currency).
-- Any rollup mixing them must convert — see the V5 profitability view.

-- ── Provenance ──────────────────────────────────────────────────────────────

alter table public.orders
  add column if not exists cogs_basis text;

comment on column public.orders.cogs_basis is
  'How cogs_usd was derived: batch_actual = invoiced batches.unit_cost_usd of '
  'the linked unit; schedule = roadmap projection by order date; manual = '
  'operator-entered; replacement_line_items = summed from line_items cost. '
  'NULL alongside a NULL cogs_usd means uncosted.';

-- ── The fallback schedule, as a function ────────────────────────────────────

create or replace function public.sale_cogs_per_unit_usd(order_date timestamptz)
returns numeric
language sql
immutable
as $$
  select case
    when order_date is null        then 658.00  -- undated legacy rows: baseline
    when order_date < '2026-06-01' then 658.00
    when order_date < '2026-08-01' then 410.00
    when order_date < '2027-07-01' then 380.00
    when order_date < '2027-12-01' then 320.00
    else                                300.00
  end::numeric(12,2);
$$;

comment on function public.sale_cogs_per_unit_usd(timestamptz) is
  'Per-unit sale COGS in USD projected for an order placed on the given date. '
  'Fallback only — prefer the actual batches.unit_cost_usd of the linked unit.';

-- Unit count for an order, from line_items[*].qty. Floors at 1 so a
-- single-line order with no explicit qty still costs correctly.
create or replace function public.order_unit_count(line_items jsonb)
returns int
language sql
immutable
as $$
  select greatest(
    coalesce((select sum((li->>'qty')::int)
              from jsonb_array_elements(coalesce(line_items, '[]'::jsonb)) li
              where li ? 'qty'), 0),
    1
  );
$$;

-- Actual invoiced cost of the units that shipped against an order_ref, summed
-- across all linked units. NULL when no unit is linked or no linked unit's
-- batch has been costed — caller falls back to the schedule.
create or replace function public.order_actual_cogs_usd(p_order_ref text)
returns numeric
language sql
stable
as $$
  select sum(b.unit_cost_usd)::numeric(12,2)
  from public.units u
  join public.batches b on b.id = u.batch
  where u.customer_order_ref = p_order_ref
    and b.unit_cost_usd is not null;
$$;

comment on function public.order_actual_cogs_usd(text) is
  'Summed invoiced batch cost (USD) of every unit linked to this order_ref. '
  'NULL when the order has no linked+costed unit.';

-- ── Trigger: cost sale orders on arrival ────────────────────────────────────
-- Fills only when cogs_usd IS NULL, so an operator correction and the
-- replacement flow''s computed cogs are both preserved. A newly-inserted order
-- rarely has its unit linked yet, so it usually lands on the schedule and is
-- upgraded to batch_actual by the next apply_sale_cogs_schedule() run.

create or replace function public.set_sale_cogs_from_schedule()
returns trigger
language plpgsql
as $$
declare
  actual numeric;
begin
  if new.kind = 'sale' and new.cogs_usd is null then
    actual := public.order_actual_cogs_usd(new.order_ref);
    if actual is not null then
      new.cogs_usd  := actual;
      new.cogs_basis := 'batch_actual';
    else
      new.cogs_usd := (
        public.order_unit_count(new.line_items)
        * public.sale_cogs_per_unit_usd(coalesce(new.placed_at, new.created_at, now()))
      )::numeric(12,2);
      new.cogs_basis := 'schedule';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_set_sale_cogs on public.orders;
create trigger orders_set_sale_cogs
  before insert or update on public.orders
  for each row execute function public.set_sale_cogs_from_schedule();

-- ── Repeatable backfill ─────────────────────────────────────────────────────
-- Fills NULLs, upgrades schedule-derived rows to batch_actual once their unit
-- link appears, and re-keys stale created_at-derived values. A cogs_usd that
-- matches no value this function could have produced is treated as
-- operator-entered and left alone (and stamped cogs_basis='manual').

create or replace function public.apply_sale_cogs_schedule()
returns table (basis text, rows_touched int)
language plpgsql
as $$
begin
  return query
  with scheduled as (
    select
      o.id,
      o.cogs_usd as have,
      public.order_unit_count(o.line_items) as units,
      public.order_actual_cogs_usd(o.order_ref) as actual,
      (public.order_unit_count(o.line_items)
       * public.sale_cogs_per_unit_usd(coalesce(o.placed_at, o.created_at)))::numeric(12,2) as projected
    from public.orders o
    where o.kind = 'sale'
  ),
  target as (
    select
      s.id,
      s.have,
      coalesce(s.actual, s.projected) as want,
      case when s.actual is not null then 'batch_actual' else 'schedule' end as want_basis,
      -- values any generation of this backfill could have produced
      (s.have is null
       or s.have = s.actual
       or s.have = (s.units * 659.00)::numeric(12,2)   -- 20260605020000 placeholder
       or s.have in (
            (s.units * 658.00)::numeric(12,2), (s.units * 410.00)::numeric(12,2),
            (s.units * 380.00)::numeric(12,2), (s.units * 320.00)::numeric(12,2),
            (s.units * 300.00)::numeric(12,2))
      ) as derived
    from scheduled s
  ),
  upd as (
    update public.orders o
    set cogs_usd   = t.want,
        cogs_basis = t.want_basis
    from target t
    where o.id = t.id
      and t.derived
      and (o.cogs_usd is distinct from t.want or o.cogs_basis is distinct from t.want_basis)
    returning t.want_basis as b
  ),
  mark_manual as (
    update public.orders o
    set cogs_basis = 'manual'
    from target t
    where o.id = t.id
      and not t.derived
      and o.cogs_basis is distinct from 'manual'
    returning 'manual'::text as b
  )
  select b, count(*)::int from (select b from upd union all select b from mark_manual) x
  group by b;
end;
$$;

comment on function public.apply_sale_cogs_schedule() is
  'Repeatable sale-COGS backfill: actual invoiced batch cost where the order '
  'links to a costed unit, else the roadmap schedule keyed on '
  'coalesce(placed_at, created_at). Preserves operator-entered values. '
  'Safe to replay.';

select * from public.apply_sale_cogs_schedule();
