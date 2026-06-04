-- Backlog #68 continuation: update the customer_profitability view to
-- prefer the new orders.customer_id FK over the fuzzy email/name join.
-- Falls back to the email/name match only for rows where customer_id is
-- still null (no current row in prod, but keeps the view robust).

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
    o.customer_id = c.id
    or (o.customer_id is null and (
      (o.customer_email is not null and c.email is not null
       and lower(o.customer_email) = lower(c.email))
      or ((o.customer_email is null or c.email is null)
          and lower(o.customer_name) = lower(c.full_name))
    ))
  )
),
order_agg as (
  select
    customer_id,
    coalesce(sum(total_usd) filter (where kind = 'sale'), 0)::numeric(12,2)        as revenue_usd,
    coalesce(sum(cogs_usd), 0)::numeric(12,2)                                       as cogs_usd,
    coalesce(sum(shipping_cost_usd), 0)::numeric(12,2)                              as shipping_cost_usd,
    coalesce(sum(coalesce(cogs_usd, 0) + coalesce(shipping_cost_usd, 0))
             filter (where kind = 'replacement'), 0)::numeric(12,2)                 as warranty_cost_usd,
    count(*) filter (where order_id is not null and kind = 'sale')                  as order_count,
    count(*) filter (where order_id is not null and kind = 'replacement')           as replacement_count
  from order_match
  group by customer_id
),
refund_agg as (
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
