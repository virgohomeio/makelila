-- Helper RPCs and view for Freightcom shipment sync.
--
-- match_shipment_serials: matches shipments.primary_tracking_number → units.tracking_num
--   and writes back unit_serial. Called at the end of sync-freightcom-shipments.
--
-- match_shipment_orders: propagates order_id from units.customer_order_ref → orders
--   for rows that have a unit_serial but no order_id yet.
--
-- v_customer_shipping_costs: per-customer cost rollup view for the Shipping module.

-- ── match_shipment_serials ────────────────────────────────────────────────────

create or replace function public.match_shipment_serials()
returns void
language sql
security definer
as $$
  update public.shipments s
  set    unit_serial = u.serial
  from   public.units u
  where  s.primary_tracking_number is not null
    and  s.primary_tracking_number <> ''
    and  s.unit_serial is null
    and  u.tracking_num = s.primary_tracking_number;
$$;

-- ── match_shipment_orders ─────────────────────────────────────────────────────

create or replace function public.match_shipment_orders()
returns void
language sql
security definer
as $$
  update public.shipments s
  set    order_id = o.id
  from   public.units u
  join   public.orders o on o.order_ref = u.customer_order_ref
  where  s.unit_serial = u.serial
    and  s.order_id is null
    and  u.customer_order_ref is not null;
$$;

-- ── v_customer_shipping_costs ─────────────────────────────────────────────────
-- Per-customer shipping cost summary.
-- Joins: shipments → units (unit_serial) → orders (customer_order_ref)
-- Falls back to order_id FK when unit_serial is not set.

create or replace view public.v_customer_shipping_costs as
select
  -- Identity (prefer order-level data, fall back to unit-level)
  coalesce(o.customer_name, u.customer_name)   as customer_name,
  coalesce(o.customer_email, '')               as customer_email,
  coalesce(o.id, s.order_id)                  as order_id,
  coalesce(o.order_ref, u.customer_order_ref)  as order_ref,

  -- Unit
  s.unit_serial,

  -- Shipment details
  s.id                          as shipment_id,
  s.freightcom_shipment_id,
  s.carrier,
  s.service,
  s.primary_tracking_number,
  s.status                      as shipment_status,

  -- Financials (CAD)
  s.rate_cad                    as quoted_cad,
  s.billed_cad,
  s.base_charge_cad,
  s.fuel_surcharge_cad,
  s.residential_surcharge_cad,
  s.remote_surcharge_cad,
  s.other_surcharges,
  s.invoice_number,
  s.invoice_date,

  -- Geography
  s.dest_city,
  s.dest_province,
  s.dest_country,

  -- Dates
  s.booked_at,
  s.picked_up_at,
  s.estimated_delivery,
  s.delivered_at,
  s.transit_days,

  -- What customer paid (from orders table)
  o.customer_paid_shipping_usd,
  o.shipping_cost_usd            as historical_shipping_cost_usd

from public.shipments s
left join public.units  u on u.serial    = s.unit_serial
left join public.orders o on (
  -- direct FK takes priority
  o.id = s.order_id
  or
  -- fall back: unit → order via customer_order_ref
  (s.order_id is null and u.customer_order_ref is not null
   and o.order_ref = u.customer_order_ref)
);

-- RLS: same internal-only policy as the underlying shipments table
-- (views inherit the table's RLS, but we add the comment for clarity)
-- No additional GRANT needed — internal users already have SELECT on shipments.

-- ── Aggregate view: one row per customer ─────────────────────────────────────

create or replace view public.v_customer_shipping_summary as
select
  customer_name,
  customer_email,
  order_ref,
  count(*)                                as shipment_count,
  sum(billed_cad)                         as total_billed_cad,
  sum(quoted_cad)                         as total_quoted_cad,
  sum(billed_cad) - sum(quoted_cad)       as cost_vs_quote_cad,
  array_agg(distinct carrier)             as carriers_used,
  min(booked_at)                          as first_shipment_at,
  max(booked_at)                          as last_shipment_at,
  count(*) filter (where shipment_status = 'delivered') as delivered_count,
  count(*) filter (where shipment_status in ('exception','missing')) as problem_count
from public.v_customer_shipping_costs
group by customer_name, customer_email, order_ref
order by total_billed_cad desc nulls last;
