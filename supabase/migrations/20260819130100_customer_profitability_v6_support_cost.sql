-- Backlog #58 V6 — add diagnosis-call labour as a 5th cost bucket.
--
-- V5 costed goods, freight, warranty replacements and refunds. It did not cost
-- the team's time. A customer like Ronald Hatch, with three diagnosis calls
-- and a no-show, carried the same modelled cost-to-serve as a customer who
-- never called — so "most profitable" was ranking on an incomplete number.
--
-- support_cost_cad = sum over ALL of that customer's calls of
--   (duration_minutes / 60) * internal_attendees * blended person-hour rate
--
-- See 20260819130000 for the rate model and why it is blended rather than
-- per-person. No-shows are included: the team waited in the room and phoned
-- the customer, and that time was paid. diagnosis_noshow_count breaks out the
-- subset so a customer who burns time by not showing up is still legible as
-- such on the card.
--
-- support_cost_cad is NULL, not 0, until an operator sets the rate:
--   update public.support_rates set hourly_cad = <rate>, updated_at = now()
--    where role_key = 'internal_person_hour';
-- net_margin_cad coalesces it to 0 so margins keep working meanwhile.

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
    o.shipping_cost_currency
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
    -- Revenue: sale orders net of sales tax, converted from the order's own
    -- currency. Tax is pass-through to govt, not VCycene revenue.
    coalesce(sum(public.to_cad(total_usd - coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as revenue_cad,
    coalesce(sum(public.to_cad(coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as tax_collected_cad,
    -- COGS is USD-denominated on every row regardless of the order's currency.
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
    -- Cost coverage, so partial data reads as partial rather than as $0.
    count(*) filter (where kind = 'sale' and cogs_basis = 'batch_actual')           as cogs_actual_count,
    count(*) filter (where kind = 'sale' and cogs_basis = 'schedule')               as cogs_modelled_count,
    count(*) filter (where kind = 'sale' and shipping_cost_usd is not null)         as shipping_costed_count,
    count(*) filter (where order_id is not null and kind = 'sale'
                     and shipping_cost_usd is null)                                 as shipping_uncosted_count
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
  -- Diagnosis-call labour. Joined the same way refund_agg joins returns:
  -- customer_id when the seed matched, else email, else name — several of
  -- these customers have no customers row, or book under a second address.
  select
    c.id as customer_id,
    -- No filter on attended: a no-show costs the same person-hours as a call.
    sum(public.diagnosis_call_cost_cad(dc.duration_minutes, dc.internal_attendees)) as support_cost_cad,
    coalesce(sum(dc.duration_minutes), 0)::numeric(10,2)                            as diagnosis_minutes,
    count(dc.id)                                                                    as diagnosis_call_count,
    -- Subset of the above, not additional to it.
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
  -- 5th bucket. NULL (not 0) while support_rates.hourly_cad is unset, so the
  -- card can say "rate not set" rather than claim these calls were free.
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
  -- Subset of diagnosis_call_count where the customer never joined. Billed
  -- like any other call; surfaced separately so the waste stays legible.
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
  'Backlog #58 V6: 5-bucket profitability in CAD (COGS, freight, warranty, '
  'refunds, diagnosis-call labour). support_cost_cad is NULL until '
  'support_rates.hourly_cad is set; net_margin_cad treats NULL as 0. '
  'Covers every call including no-shows; diagnosis_noshow_count is the subset '
  'the customer never joined.';
