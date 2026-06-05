-- Backlog #58 V4 — split sales tax out of revenue on customer_profitability.
--
-- Operator request (Huayi, 2026-06-05): "Revenue includes sales taxes —
-- need to add that as a line item." Tax is collected on behalf of the
-- government and passes through to the relevant tax authority; it's not
-- VCycene revenue and shouldn't be counted in margin calcs.
--
-- Change:
--   • revenue_usd       was sum(total_usd) → now sum(total_usd - coalesce(tax_usd, 0))
--     Net-of-tax revenue. Still includes shipping the customer paid us
--     (that's offset elsewhere by sale_shipping_usd, our shipping cost).
--   • NEW tax_collected_usd column = sum(coalesce(tax_usd, 0)). Informational
--     only — not part of the margin formula. Lets ops see how much was
--     remitted to tax authorities.
--
-- Behavior for the 40 sale orders where tax_usd is NULL (older imports
-- where Shopify breakdown wasn't synced): coalesce treats them as 0 tax,
-- so their revenue stays at total_usd — same as the V3 view. When
-- sync-shopify-orders runs against those rows, the breakdown fills in
-- and revenue auto-adjusts.

drop view if exists public.customer_profitability;

create view public.customer_profitability as
with order_match as (
  select
    c.id as customer_id,
    o.id as order_id,
    o.kind,
    o.status,
    o.total_usd,
    o.tax_usd,
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
    -- Revenue: sale orders net of sales tax. Tax is pass-through to govt,
    -- not VCycene revenue. Coalesce defaults missing tax_usd → 0 so
    -- pre-Shopify-sync rows still report total_usd as revenue.
    coalesce(sum(total_usd - coalesce(tax_usd, 0))
             filter (where kind = 'sale'), 0)::numeric(12,2)                          as revenue_usd,
    -- Tax collected on behalf of govt — surfaced separately for audit.
    coalesce(sum(coalesce(tax_usd, 0))
             filter (where kind = 'sale'), 0)::numeric(12,2)                          as tax_collected_usd,
    coalesce(sum(cogs_usd) filter (where kind = 'sale'), 0)::numeric(12,2)            as sale_cogs_usd,
    coalesce(sum(shipping_cost_usd) filter (where kind = 'sale'), 0)::numeric(12,2)   as sale_shipping_usd,
    coalesce(sum(
      coalesce(cogs_usd, 0) + coalesce(shipping_cost_usd, 0)
    ) filter (where kind = 'replacement' and status <> 'cancelled'), 0)::numeric(12,2) as expected_warranty_cost_usd,
    count(*) filter (where order_id is not null and kind = 'sale')                     as order_count,
    count(*) filter (where order_id is not null and kind = 'replacement')              as replacement_count,
    count(*) filter (where order_id is not null and kind = 'replacement'
                     and status not in ('delivered', 'closed'))                        as open_replacement_count
  from order_match
  group by customer_id
),
refund_agg as (
  select
    c.id as customer_id,
    coalesce(sum(ra.refund_amount_usd) filter (where ra.status <> 'denied'),
             0)::numeric(12,2) as expected_refund_usd,
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
  oa.revenue_usd,
  oa.tax_collected_usd,
  oa.sale_cogs_usd,
  oa.sale_shipping_usd,
  oa.expected_warranty_cost_usd,
  coalesce(ra.expected_refund_usd, 0)::numeric(12,2)                               as expected_refund_usd,
  (
    oa.revenue_usd
    - oa.sale_cogs_usd
    - oa.sale_shipping_usd
    - oa.expected_warranty_cost_usd
    - coalesce(ra.expected_refund_usd, 0)
  )::numeric(12,2)                                                                  as net_margin_usd,
  coalesce(ra.settled_refund_usd, 0)::numeric(12,2)                                as settled_refund_usd,
  oa.order_count,
  oa.replacement_count,
  oa.open_replacement_count,
  coalesce(ra.refund_count, 0)::int                                                 as refund_count,
  coalesce(ra.in_flight_refund_count, 0)::int                                       as in_flight_refund_count,
  coalesce(ta.ticket_count, 0)::int                                                 as ticket_count,
  coalesce(ta.open_warranty_ticket_count, 0)::int                                   as open_warranty_ticket_count,
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
  'Backlog #58 V4: 4-bucket profitability model with tax split out of revenue. '
  'revenue_usd excludes tax; tax_collected_usd surfaces the pass-through amount.';
