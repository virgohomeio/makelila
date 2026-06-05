-- Backlog #58 V3 — rebuild customer_profitability view with a cleaner
-- 4-cost-bucket model so the Profitability tab maps 1:1 to the costs
-- operators actually want to reason about:
--
--   1. Cost of goods sold      (sale orders only)
--   2. Shipping cost           (sale orders only)
--   3. Expected warranty cost  (ALL non-cancelled replacement orders)
--   4. Expected refunds cost   (ALL non-denied refund_approvals)
--
-- The previous (V2) view had two problems:
--   • cogs_usd + shipping_cost_usd silently included replacement-order
--     costs, AND warranty_cost_usd also included them — a partial
--     double-display in the UI breakdown.
--   • refund_usd only summed status='refunded', missing in-flight
--     refund approvals (manager_review + finance_review). A customer
--     with a $2k refund pending finance review showed as "no refund cost"
--     until the day the refund cleared.
--
-- The "expected" qualifier on warranty + refunds reflects what we
-- expect to spend based on REAL records that already exist (orders we
-- created, refund approvals we've started), not modeling/forecasting.
-- Open warranty tickets without a replacement order are surfaced as a
-- separate count column (open_warranty_ticket_count) — they're a
-- leading indicator that expected warranty will grow, but we can't
-- quantify the cost until the replacement order is created.

-- DROP + CREATE rather than CREATE OR REPLACE because Postgres rejects
-- column renames via OR REPLACE (V2's column names changed here).
drop view if exists public.customer_profitability;

create view public.customer_profitability as
with order_match as (
  -- Same join shape as V2: customers.id ↔ orders via the canonical FK
  -- where set (#67 backfill), falling back to email/name match for
  -- pre-FK rows. Keep both join legs in the OR so the view still
  -- works during the FK transition.
  select
    c.id as customer_id,
    o.id as order_id,
    o.kind,
    o.status,
    o.total_usd,
    o.cogs_usd,
    o.shipping_cost_usd
  from public.customers c
  left join public.orders o on (
    (o.customer_id = c.id)
    or (o.customer_id is null
        and (
          (o.customer_email is not null and c.email is not null
           and lower(o.customer_email) = lower(c.email))
          or lower(o.customer_name) = lower(c.full_name)
        )
       )
  )
),
order_agg as (
  select
    customer_id,
    -- Revenue: sale orders only, what the customer actually paid.
    coalesce(sum(total_usd) filter (where kind = 'sale'), 0)::numeric(12,2)              as revenue_usd,
    -- (1) Cost of goods sold — SALES ONLY. Replacement-order cogs are
    -- captured under expected_warranty_cost_usd below.
    coalesce(sum(cogs_usd) filter (where kind = 'sale'), 0)::numeric(12,2)               as sale_cogs_usd,
    -- (2) Shipping — SALES ONLY. Same reasoning.
    coalesce(sum(shipping_cost_usd) filter (where kind = 'sale'), 0)::numeric(12,2)      as sale_shipping_usd,
    -- (3) Expected warranty cost = cogs + shipping on ALL replacement
    -- orders that aren't cancelled. Status filter is defensive — the
    -- orders table doesn't currently have 'cancelled' as a status value,
    -- but if it ever does, those shouldn't count toward future cost.
    coalesce(sum(
      coalesce(cogs_usd, 0) + coalesce(shipping_cost_usd, 0)
    ) filter (where kind = 'replacement' and status <> 'cancelled'), 0)::numeric(12,2)   as expected_warranty_cost_usd,
    -- Counts
    count(*) filter (where order_id is not null and kind = 'sale')                        as order_count,
    count(*) filter (where order_id is not null and kind = 'replacement')                 as replacement_count,
    count(*) filter (where order_id is not null and kind = 'replacement'
                     and status not in ('delivered', 'closed'))                           as open_replacement_count
  from order_match
  group by customer_id
),
refund_agg as (
  -- (4) Expected refunds = ALL non-denied refund approvals (manager_review,
  -- finance_review, refunded). Customer match via returns table, same
  -- email/name pattern as orders.
  select
    c.id as customer_id,
    coalesce(sum(ra.refund_amount_usd) filter (where ra.status <> 'denied'),
             0)::numeric(12,2) as expected_refund_usd,
    -- Keep a "settled" subset (status='refunded' only) for ops who want
    -- to distinguish in-flight from booked.
    coalesce(sum(ra.refund_amount_usd) filter (where ra.status = 'refunded'),
             0)::numeric(12,2) as settled_refund_usd,
    count(ra.id) filter (where ra.status <> 'denied')                      as refund_count,
    count(ra.id) filter (where ra.status in ('manager_review','finance_review')) as in_flight_refund_count
  from public.customers c
  left join public.returns r on (
    (r.customer_email is not null and c.email is not null
     and lower(r.customer_email) = lower(c.email))
    or lower(r.customer_name) = lower(c.full_name)
  )
  left join public.refund_approvals ra on ra.return_id = r.id
  group by c.id
),
ticket_agg as (
  select
    customer_id,
    count(*)                                                                       as ticket_count,
    count(*) filter (
      where topic in ('return_hardware_defect', 'warranty_replacement')
        and status not in ('resolved', 'closed')
        and replacement_order_id is null
    )                                                                              as open_warranty_ticket_count
  from public.service_tickets
  where customer_id is not null
  group by customer_id
)
select
  c.id,
  c.full_name,
  c.email,
  c.country,
  c.onboard_date,
  -- Revenue
  oa.revenue_usd,
  -- 4-bucket cost model
  oa.sale_cogs_usd,
  oa.sale_shipping_usd,
  oa.expected_warranty_cost_usd,
  coalesce(ra.expected_refund_usd, 0)::numeric(12,2)                               as expected_refund_usd,
  -- Net margin uses the 4 buckets — no double-count of replacement costs.
  (
    oa.revenue_usd
    - oa.sale_cogs_usd
    - oa.sale_shipping_usd
    - oa.expected_warranty_cost_usd
    - coalesce(ra.expected_refund_usd, 0)
  )::numeric(12,2)                                                                  as net_margin_usd,
  -- Settled-refund subset (status='refunded' only) for operators who want
  -- to see "how much have we actually paid out" vs the expected total.
  coalesce(ra.settled_refund_usd, 0)::numeric(12,2)                                as settled_refund_usd,
  -- Counts
  oa.order_count,
  oa.replacement_count,
  oa.open_replacement_count,
  coalesce(ra.refund_count, 0)::int                                                 as refund_count,
  coalesce(ra.in_flight_refund_count, 0)::int                                       as in_flight_refund_count,
  coalesce(ta.ticket_count, 0)::int                                                 as ticket_count,
  coalesce(ta.open_warranty_ticket_count, 0)::int                                   as open_warranty_ticket_count,
  -- Convenience: team-member flag (used by the UI to default-hide team
  -- accounts so they don't skew the cohort summaries).
  exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(c.full_name)
       or lower(c.full_name) like lower(t.display_name) || ' %'
  )                                                                                 as is_team_member
from public.customers c
left join order_agg oa on oa.customer_id = c.id
left join refund_agg ra on ra.customer_id = c.id
left join ticket_agg ta on ta.customer_id = c.id;

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V3: per-customer profitability with 4-bucket cost model — '
  'sale_cogs + sale_shipping + expected_warranty (all non-cancelled '
  'replacement-order cogs+shipping) + expected_refund (all non-denied '
  'refund_approvals). open_warranty_ticket_count is a leading indicator '
  'for warranty cost growth (tickets flagged as defect/warranty that '
  'have no replacement order yet).';
