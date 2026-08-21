-- Backlog #58 V7 — only flag freight as "uncosted" on orders that shipped.
--
-- shipping_uncosted_count counted every sale order with a NULL
-- shipping_cost_usd. On today's data that is 102 of 215 sale orders, and 99 of
-- those never shipped: 83 are still `pending`, 12 are `cancelled`, and 4 more
-- have no unit assigned. Those orders have no freight cost because no freight
-- was bought — not because a number is missing.
--
-- The result was a card like Joseph Thavundayil's reading "$0.00 (1 uncosted)"
-- next to a warning tooltip, on orders where $0.00 is the correct answer, and
-- an amber hint that trained operators to ignore the one case that matters.
--
-- Shipped is defined as "a unit is assigned to this order"
-- (units.customer_order_ref = orders.order_ref) rather than by order status.
-- Status does not separate the two: `pending` holds 40 costed orders and 83
-- uncosted ones, because the status tracks review state, not fulfilment.
--
-- After this, shipping_uncosted_count is 3 — #1174, #1177 and IP-UOF-258, all
-- of which really did ship a machine and really are missing their freight
-- invoice. None of the 28 unlinked shipments carry those serials, so the cost
-- is absent from public.shipments entirely and has to come from the Freightcom
-- portal by hand. Worth keeping visible, which is the point of narrowing it.
--
-- Only the one count changes; every amount is identical to V6.

drop view if exists public.customer_profitability;

create view public.customer_profitability as
with order_match as (
  select
    c.id as customer_id,
    o.id as order_id,
    o.kind,
    o.status,
    o.currency,
    o.total_usd,
    o.tax_usd,
    o.cogs_usd,
    o.cogs_basis,
    o.shipping_cost_usd,
    o.shipping_cost_currency,
    -- Did a machine actually go out the door against this order?
    exists (select 1 from public.units un
            where un.customer_order_ref = o.order_ref) as order_shipped
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
    coalesce(sum(public.to_cad(total_usd - coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as revenue_cad,
    coalesce(sum(public.to_cad(coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as tax_collected_cad,
    coalesce(sum(public.to_cad(cogs_usd, 'USD'))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as sale_cogs_cad,
    coalesce(sum(public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD')))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as sale_shipping_cad,
    coalesce(sum(
      coalesce(public.to_cad(cogs_usd, 'USD'), 0)
      + coalesce(public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD')), 0)
    ) filter (where kind = 'replacement' and status <> 'cancelled'), 0)::numeric(12,2)
                                                                                   as expected_warranty_cost_cad,
    count(*) filter (where order_id is not null and kind = 'sale')                  as order_count,
    count(*) filter (where order_id is not null and kind = 'replacement')           as replacement_count,
    count(*) filter (where order_id is not null and kind = 'replacement'
                     and status not in ('delivered', 'closed'))                     as open_replacement_count,
    count(*) filter (where kind = 'sale' and cogs_basis = 'batch_actual')           as cogs_actual_count,
    count(*) filter (where kind = 'sale' and cogs_basis = 'schedule')               as cogs_modelled_count,
    count(*) filter (where kind = 'sale' and shipping_cost_usd is not null)         as shipping_costed_count,
    -- V7: shipped orders only. An unshipped order has no freight to be missing.
    count(*) filter (where order_id is not null and kind = 'sale'
                     and shipping_cost_usd is null and order_shipped)               as shipping_uncosted_count
  from order_match
  group by customer_id
),
refund_agg as (
  select
    c.id as customer_id,
    coalesce(sum(public.to_cad(ra.refund_amount_usd, ra.currency))
             filter (where ra.status <> 'denied'), 0)::numeric(12,2) as expected_refund_cad,
    coalesce(sum(public.to_cad(ra.refund_amount_usd, ra.currency))
             filter (where ra.status = 'refunded'), 0)::numeric(12,2) as settled_refund_cad,
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
support_agg as (
  select
    c.id as customer_id,
    sum(public.diagnosis_call_cost_cad(dc.duration_minutes, dc.internal_attendees)) as support_cost_cad,
    coalesce(sum(dc.duration_minutes), 0)::numeric(10,2)                            as diagnosis_minutes,
    count(dc.id)                                                                    as diagnosis_call_count,
    count(dc.id) filter (where not dc.attended)                                     as diagnosis_noshow_count
  from public.customers c
  left join public.diagnosis_calls dc on (
    (dc.customer_id = c.id)
    or (dc.customer_id is null
        and (
          (dc.customer_email is not null and c.email is not null
           and lower(dc.customer_email) = lower(c.email))
          or lower(dc.customer_name) = lower(c.full_name)
        )
       )
  )
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
  oa.revenue_cad,
  oa.tax_collected_cad,
  oa.sale_cogs_cad,
  oa.sale_shipping_cad,
  oa.expected_warranty_cost_cad,
  coalesce(ra.expected_refund_cad, 0)::numeric(12,2)                               as expected_refund_cad,
  sa.support_cost_cad::numeric(12,2)                                               as support_cost_cad,
  (
    oa.revenue_cad
    - oa.sale_cogs_cad
    - oa.sale_shipping_cad
    - oa.expected_warranty_cost_cad
    - coalesce(ra.expected_refund_cad, 0)
    - coalesce(sa.support_cost_cad, 0)
  )::numeric(12,2)                                                                  as net_margin_cad,
  coalesce(ra.settled_refund_cad, 0)::numeric(12,2)                                as settled_refund_cad,
  oa.order_count,
  oa.replacement_count,
  oa.open_replacement_count,
  oa.cogs_actual_count,
  oa.cogs_modelled_count,
  oa.shipping_costed_count,
  oa.shipping_uncosted_count,
  coalesce(ra.refund_count, 0)::int                                                 as refund_count,
  coalesce(ra.in_flight_refund_count, 0)::int                                       as in_flight_refund_count,
  coalesce(ta.ticket_count, 0)::int                                                 as ticket_count,
  coalesce(ta.open_warranty_ticket_count, 0)::int                                   as open_warranty_ticket_count,
  coalesce(sa.diagnosis_call_count, 0)::int                                         as diagnosis_call_count,
  coalesce(sa.diagnosis_minutes, 0)::numeric(10,2)                                  as diagnosis_minutes,
  coalesce(sa.diagnosis_noshow_count, 0)::int                                       as diagnosis_noshow_count,
  exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(c.full_name)
       or lower(c.full_name) like lower(t.display_name) || ' %'
  )                                                                                 as is_team_member
from public.customers c
left join order_agg oa on oa.customer_id = c.id
left join refund_agg ra on ra.customer_id = c.id
left join ticket_agg ta on ta.customer_id = c.id
left join support_agg sa on sa.customer_id = c.id;

alter view public.customer_profitability set (security_invoker = true);

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V7: 5-bucket profitability in CAD (COGS, freight, warranty, '
  'refunds, diagnosis-call labour). shipping_uncosted_count counts only '
  'orders that shipped a unit but have no freight invoice — an unshipped '
  'order is not a data gap. support_cost_cad is NULL until '
  'support_rates.hourly_cad is set.';
