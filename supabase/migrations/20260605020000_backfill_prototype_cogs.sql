-- Backlog #58 V3 follow-up — prototype-era COGS backfill on sale orders.
--
-- Source: V-SAX fundraising roadmap (per Huayi, 2026-06-05). All
-- prototype batches prior to P100X (P50, P150, P50N, P100) share a
-- flat per-unit COGS of $659 USD. Future batches (P150X+) will use
-- per-batch projections from the same document; that's a separate
-- backfill once the projections are encoded.
--
-- Scope: every public.orders row where kind='sale' AND cogs_usd IS NULL.
-- We use line_items[*].qty for the unit count (handles 2-pack orders
-- correctly — exactly 1 in production today, Sahar Alhusseink #1171).
-- Replacement orders are skipped — they get cogs set at order-creation
-- time via the #55 flow.
--
-- Idempotency: the WHERE cogs_usd IS NULL filter makes this safe to
-- replay. Re-runs on already-backfilled rows are no-ops. If a future
-- migration introduces P150X+ sale orders with non-null cogs, those
-- rows are also untouched.

with per_order as (
  select o.order_ref, coalesce(sum((li->>'qty')::int), 1) as units
  from public.orders o
  left join lateral jsonb_array_elements(o.line_items) li on true
  where o.kind = 'sale'
  group by o.order_ref
)
update public.orders o
set cogs_usd = (p.units * 659.00)::numeric(12,2)
from per_order p
where o.order_ref = p.order_ref
  and o.kind = 'sale'
  and o.cogs_usd is null;
