-- Customer profitability view for backlog #58.
-- Aggregates per-customer revenue, COGS, shipping, refunds, warranty cost,
-- and counts in a single Postgres query so the browser doesn't have to
-- join thousands of rows client-side.
--
-- Customer matching: orders.customer_email ILIKE customers.email (the most
-- reliable join key). Falls through to lower(full_name) = lower(customer_name)
-- when email is missing on either side. Some customers (especially older
-- imports) lack email so the name fallback catches them.
--
-- The view exposes one row per customers.id, even when the customer has
-- zero orders (revenue/counts come back 0). The Profitability tab decides
-- whether to hide zero-activity rows.

create or replace view public.customer_profitability as
with order_match as (
  select
    c.id as customer_id,
    o.id as order_id,
    o.kind,
    o.total_usd,
    o.cogs_usd,
    o.shipping_cost_usd,
    o.created_at
  from public.customers c
  left join public.orders o on (
    (o.customer_email is not null and c.email is not null
     and lower(o.customer_email) = lower(c.email))
    or (o.customer_email is null or c.email is null)
       and lower(o.customer_name) = lower(c.full_name)
  )
),
order_agg as (
  select
    customer_id,
    -- Revenue: only sale orders that the customer actually paid for.
    coalesce(sum(total_usd) filter (where kind = 'sale'), 0)::numeric(12,2)        as revenue_usd,
    -- COGS: across both sales and replacements. cogs_usd is null for
    -- sales that haven't been backfilled yet (most existing rows).
    coalesce(sum(cogs_usd), 0)::numeric(12,2)                                       as cogs_usd,
    -- Actual shipping label cost, populated by the Fulfillment step prompt
    -- once the operator enters it. Backlog #65 made this column real.
    coalesce(sum(shipping_cost_usd), 0)::numeric(12,2)                              as shipping_cost_usd,
    -- Warranty cost = COGS + shipping_cost on replacement orders. This is
    -- the single most useful signal for "is this customer profitable?".
    coalesce(sum(coalesce(cogs_usd, 0) + coalesce(shipping_cost_usd, 0))
             filter (where kind = 'replacement'), 0)::numeric(12,2)                 as warranty_cost_usd,
    count(*) filter (where order_id is not null and kind = 'sale')                  as order_count,
    count(*) filter (where order_id is not null and kind = 'replacement')           as replacement_count
  from order_match
  group by customer_id
),
refund_agg as (
  -- Sum the APPROVED refund amount (refund_approvals.refund_amount_usd) for
  -- every refund_approvals row in status='refunded' linked back to the
  -- customer via returns.customer_email / customer_name.
  select
    c.id as customer_id,
    coalesce(sum(ra.refund_amount_usd), 0)::numeric(12,2) as refund_usd,
    count(ra.id) as refund_count
  from public.customers c
  left join public.returns r on (
    (r.customer_email is not null and c.email is not null
     and lower(r.customer_email) = lower(c.email))
    or lower(r.customer_name) = lower(c.full_name)
  )
  left join public.refund_approvals ra on ra.return_id = r.id and ra.status = 'refunded'
  group by c.id
),
ticket_agg as (
  select
    customer_id,
    count(*) filter (where customer_id is not null) as ticket_count
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
  oa.revenue_usd,
  oa.cogs_usd,
  oa.shipping_cost_usd,
  oa.warranty_cost_usd,
  coalesce(ra.refund_usd, 0)::numeric(12,2)                                         as refund_usd,
  (oa.revenue_usd - oa.cogs_usd - oa.shipping_cost_usd
   - coalesce(ra.refund_usd, 0))::numeric(12,2)                                     as net_margin_usd,
  oa.order_count,
  oa.replacement_count,
  coalesce(ra.refund_count, 0)::int                                                 as refund_count,
  coalesce(ta.ticket_count, 0)::int                                                 as ticket_count,
  -- Convenience: is this customer's name in team_invite_list (matches by
  -- exact display_name)? UI uses this to default-filter team profiles out
  -- of the Profitability cards.
  exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(c.full_name)
       or lower(c.full_name) like lower(t.display_name) || ' %'   -- "Pedrum Amin" matches "Pedrum"
  )                                                                                 as is_team_member
from public.customers c
left join order_agg oa on oa.customer_id = c.id
left join refund_agg ra on ra.customer_id = c.id
left join ticket_agg ta on ta.customer_id = c.id;

-- Anon and authenticated cannot select on a view directly unless RLS
-- on the underlying tables permits. Existing RLS gates customers/orders/
-- returns/refund_approvals/service_tickets to is_internal_user() — so
-- the view inherits that gating automatically. No grants needed beyond
-- the default SELECT on the view for authenticated.
grant select on public.customer_profitability to authenticated;
