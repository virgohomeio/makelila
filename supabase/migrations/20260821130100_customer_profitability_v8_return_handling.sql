-- Backlog #58 V8 — add return handling as a 6th cost bucket.
--
-- return_handling_cad = stocking + inspection + return freight, for returns
-- where the unit physically came back. See 20260821130000 for the rate model,
-- the discard rule, and why this is NOT the same thing as the $50 restocking
-- fee charged to the customer.
--
-- 46 of 51 returns qualify today: 3 were discarded by the customer and 2 have
-- not shipped. At $50 stocking and 1h inspection at $75 that is $2,300 +
-- $3,450, plus $367.27 of traceable return freight.
--
-- The components are exposed alongside the total so the card can show one
-- "Return handling" line with the split in its tooltip.

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
returns_costed as (
  -- Only returns where the unit physically arrived. disposition='discard' and
  -- status='discarded' both mean the customer binned it and nothing shipped.
  select
    r.customer_email,
    r.customer_name,
    (r.status in ('received','inspected','refunded','closed')
     and coalesce(r.disposition,'') <> 'discard')                       as unit_came_back,
    -- Operator-entered actual wins; else the Freightcom leg matched on the
    -- return's own tracking number. Matched on tracking rather than order_id
    -- so it cannot also be summed into sale_shipping_cad.
    coalesce(
      r.return_shipping_cad,
      (select sum(s.billed_amount) from public.shipments s
        where r.pickup_tracking is not null
          and s.primary_tracking_number = r.pickup_tracking)
    )                                                                   as return_freight_cad
  from public.returns r
),
return_agg as (
  select
    c.id as customer_id,
    count(*) filter (where rc.unit_came_back)                           as returns_handled,
    (count(*) filter (where rc.unit_came_back)
      * (select v.value from public.return_cost_rates v
         where v.key = 'stocking_per_unit_cad'))::numeric(12,2)         as return_stocking_cad,
    -- Priced off support_rates, so one dial moves calls and inspections alike.
    (count(*) filter (where rc.unit_came_back)
      * (select v.value from public.return_cost_rates v where v.key = 'inspection_hours')
      * (select sr.hourly_cad from public.support_rates sr
         where sr.role_key = 'internal_person_hour'))::numeric(12,2)    as return_inspection_cad,
    coalesce(sum(rc.return_freight_cad) filter (where rc.unit_came_back), 0)::numeric(12,2)
                                                                        as return_freight_cad
  from public.customers c
  left join returns_costed rc on (
    (rc.customer_email is not null and c.email is not null
     and lower(rc.customer_email) = lower(c.email))
    or lower(rc.customer_name) = lower(c.full_name)
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
  -- 6th bucket: stocking + inspection + the return freight leg. NULL while the
  -- person-hour rate is unset, for the same reason support_cost_cad is.
  (ga.return_stocking_cad + ga.return_inspection_cad + ga.return_freight_cad)::numeric(12,2)
                                                                                   as return_handling_cad,
  ga.return_stocking_cad,
  ga.return_inspection_cad,
  ga.return_freight_cad,
  coalesce(ga.returns_handled, 0)::int                                             as returns_handled,
  (
    oa.revenue_cad
    - oa.sale_cogs_cad
    - oa.sale_shipping_cad
    - oa.expected_warranty_cost_cad
    - coalesce(ra.expected_refund_cad, 0)
    - coalesce(sa.support_cost_cad, 0)
    - coalesce(ga.return_stocking_cad, 0)
    - coalesce(ga.return_inspection_cad, 0)
    - coalesce(ga.return_freight_cad, 0)
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
left join support_agg sa on sa.customer_id = c.id
left join return_agg ga on ga.customer_id = c.id;

alter view public.customer_profitability set (security_invoker = true);

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V8: 6-bucket profitability in CAD (COGS, freight, warranty, '
  'refunds, diagnosis-call labour, return handling). return_handling_cad is '
  'stocking + inspection + return-leg freight for units that physically came '
  'back; customer-discarded returns are excluded.';
