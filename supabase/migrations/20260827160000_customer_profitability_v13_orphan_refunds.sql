-- Backlog #58 V13 -- refunds that no margin could see.
--
-- refund_agg reached approvals only by walking customers -> returns ->
-- refund_approvals. An approval whose return_id is null therefore matched
-- nothing and contributed nothing, silently: $5,030.56 across five customers
-- (Marina Weiss, Sherry Tang, Gabriella Hottya, and the two founder-cohort
-- refunds booked today), all status 'refunded', all real money already paid out.
--
-- An approval carries customer_name and customer_email of its own, so the fix
-- is to match on those when there is no return to walk. The two paths are
-- UNIONed on (customer, approval) so an approval reachable both ways still
-- counts once -- double-booking a refund would be as wrong as losing it.
--
-- Nothing else changes.

drop view if exists public.customer_profitability;

create view public.customer_profitability as
with rates as (
  select
    coalesce(public.profitability_rate('payment_fee_pct'), 0)                as payment_fee_pct,
    coalesce(public.profitability_rate('sales_commission_pct'), 0)           as commission_pct,
    coalesce(public.profitability_rate('installation_cost_per_unit_cad'), 0) as install_per_unit
),
order_match as (
  select
    c.id as customer_id,
    o.id as order_id,
    o.kind,
    o.status,
    o.currency,
    o.total_usd,
    o.tax_usd,
    o.discount_total_usd,
    o.cogs_usd,
    o.cogs_basis,
    o.shipping_cost_usd,
    o.shipping_cost_currency,
    o.region_state,
    o.country as order_country,
    o.placed_at,
    o.cancelled_at,
    o.attribution_source,
    o.attribution_medium,
    o.attribution_campaign,
    -- Did a machine actually go out the door against this order?
    --
    -- V7 asked this order-level, via units.customer_order_ref. That column
    -- carries only 80 of the 176 shipped units, so the question came back
    -- "no" for orders that plainly shipped and the freight gap reported 3
    -- when it was 50. units.customer_id carries 158 of them, so ask the
    -- customer-level question as well.
    --
    -- Customer-level is coarser: a repeat buyer with one shipped unit and two
    -- orders flags both. That is an over-estimate, and an over-estimate that
    -- is stated beats a silent zero that reads as "no freight was owed".
    --
    -- Two flags, deliberately. order_traced is the strict order-level link and
    -- stays the basis for units_shipped_count, which is displayed as "Units
    -- shipped" on the customer card and must not claim a trace it does not
    -- have. order_shipped is the looser customer-level question, used only to
    -- decide whether a missing freight invoice is a real gap.
    exists (select 1 from public.units un
             where un.customer_order_ref = o.order_ref)      as order_traced,
    -- What this order's freight actually cost, shipment by shipment: the
    -- invoiced total where an invoice is on file, the synced quote otherwise.
    --
    -- The coalesce is PER SHIPMENT and that matters. Ten sale orders carry more
    -- than one shipment, and for five of them only some legs are invoiced so
    -- far. Coalescing at order level would swap the whole order's freight for
    -- the invoiced subset and quietly delete the rest -- it read as a $593
    -- saving on first run, which is the opposite of what an invoice true-up
    -- should ever do.
    --
    -- Null only when the order has no shipment rows at all, which is what makes
    -- the fallback to orders.shipping_cost_usd below fire.
    (select sum(coalesce(sic.applicable_cad, s.billed_amount))
       from public.shipments s
       left join public.shipment_invoiced_charges sic
         on sic.tracking_number = s.primary_tracking_number
      where s.order_id = o.id)                               as invoiced_freight_cad,
    (
      exists (select 1 from public.units un
               where un.customer_order_ref = o.order_ref)
      or exists (select 1 from public.units un
                  where un.customer_id = o.customer_id
                    and un.status = 'shipped')
    ) as order_shipped
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
-- The first sale order is what sets a customer's channel, cohort and place.
-- Later orders are upsells; attributing the customer to an upsell's UTM would
-- credit the wrong channel with the acquisition.
first_sale as (
  select distinct on (customer_id)
    customer_id,
    placed_at        as first_order_at,
    region_state     as first_region,
    order_country    as first_country,
    -- The original unit purchase, net of tax and net of the discount given.
    -- Everything the customer spends after this is upsell.
    public.to_cad(total_usd - coalesce(tax_usd, 0), currency)::numeric(12,2)
                     as initial_revenue_cad,
    public.to_cad(coalesce(discount_total_usd, 0), currency)::numeric(12,2)
                     as initial_discount_cad,
    attribution_source, attribution_medium, attribution_campaign
  from order_match
  where order_id is not null and kind = 'sale'
  order by customer_id, placed_at asc nulls last
),
order_agg as (
  select
    customer_id,
    coalesce(sum(public.to_cad(total_usd - coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as revenue_cad,
    coalesce(sum(public.to_cad(coalesce(tax_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as tax_collected_cad,
    -- What list price would have been. total_usd is already net of discount,
    -- so gross = net + the discount given.
    coalesce(sum(public.to_cad(coalesce(discount_total_usd, 0), currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as discount_cad,
    -- Processors charge on the amount actually collected, tax included.
    coalesce(sum(public.to_cad(total_usd, currency))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as charged_gross_cad,
    coalesce(sum(public.to_cad(cogs_usd, 'USD'))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as sale_cogs_cad,
    -- Invoiced beats quoted. shipments.billed_amount (which orders.shipping_cost_usd
    -- was populated from) is the ORIGINAL QUOTE and is never revised, so the four
    -- batch fuel-surcharge invoices Freightcom raised later were invisible.
    coalesce(sum(coalesce(
      invoiced_freight_cad,
      public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD'))
    )) filter (where kind = 'sale'), 0)::numeric(12,2)                             as sale_shipping_cad,
    count(*) filter (where kind = 'sale' and invoiced_freight_cad is not null)     as shipping_invoiced_count,
    coalesce(sum(
      coalesce(public.to_cad(cogs_usd, 'USD'), 0)
      + coalesce(invoiced_freight_cad,
                 public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD')), 0)
    ) filter (where kind = 'replacement' and status <> 'cancelled'), 0)::numeric(12,2)
                                                                                   as expected_warranty_cost_cad,
    max(placed_at) filter (where kind = 'sale')                                     as last_order_at,
    count(*) filter (where order_id is not null and kind = 'sale')                  as order_count,
    -- Strict trace only: this is shown to operators as "Units shipped".
    count(*) filter (where order_id is not null and kind = 'sale'
                     and order_traced)                                              as units_shipped_count,
    count(*) filter (where order_id is not null and kind = 'replacement')           as replacement_count,
    count(*) filter (where order_id is not null and kind = 'replacement'
                     and status not in ('delivered', 'closed'))                     as open_replacement_count,
    count(*) filter (where kind = 'sale' and cogs_basis = 'batch_actual')           as cogs_actual_count,
    count(*) filter (where kind = 'sale' and cogs_basis = 'schedule')               as cogs_modelled_count,
    count(*) filter (where kind = 'sale' and shipping_cost_usd is not null)         as shipping_costed_count,
    -- A cancelled order never shipped, so it owes no freight and must not
    -- sit in the gap. (Revenue and COGS still count cancelled sale orders --
    -- that is a separate question, tracked on its own.) An order with an
    -- invoice on file is costed even when the synced quote is null.
    count(*) filter (where order_id is not null and kind = 'sale'
                     and shipping_cost_usd is null
                     and invoiced_freight_cad is null
                     and order_shipped
                     and coalesce(status, '') <> 'cancelled'
                     and cancelled_at is null)                                      as shipping_uncosted_count
  from order_match
  group by customer_id
),
-- Which approvals belong to which customer.
--
-- The old version reached approvals ONLY through a return, so an approval with
-- a null return_id was invisible to the whole tab -- $5,030.56 of approved,
-- settled refunds across five customers, money that had genuinely gone back and
-- that no margin reflected. An approval carries its own customer_name and
-- customer_email, so when it has no return, match on those instead.
--
-- UNION (not UNION ALL) so an approval reachable both ways is still one row per
-- customer. Double-counting a refund would break the one-dollar-one-bucket rule
-- just as badly as missing it.
refund_link as (
  select distinct c.id as customer_id, ra.id as approval_id
  from public.customers c
  join public.returns r on (
    (r.customer_email is not null and c.email is not null
     and lower(r.customer_email) = lower(c.email))
    or lower(r.customer_name) = lower(c.full_name)
  )
  join public.refund_approvals ra on ra.return_id = r.id
  union
  select distinct c.id as customer_id, ra.id as approval_id
  from public.customers c
  join public.refund_approvals ra
    on ra.return_id is null
   and ((ra.customer_email is not null and c.email is not null
         and lower(ra.customer_email) = lower(c.email))
        or lower(ra.customer_name) = lower(c.full_name))
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
  left join refund_link rl on rl.customer_id = c.id
  left join public.refund_approvals ra on ra.id = rl.approval_id
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
-- Bucket 10. Consumables and repair parts bought at retail and drop-shipped to
-- the customer (Amazon worm castings, jumper caps). Product the customer keeps,
-- so it sits with cost of goods -- it is not freight, whatever the invoice was
-- filed under.
-- Pre-Freightcom freight (Canpar/GLS/Purolator/FedEx, Oct 2025 - Jan 2026).
-- Attributed to the customer, not the order: only 19 of 44 rows belong to a
-- customer with an uncosted sale order, because most of that cohort predates
-- any order record. Rows already carried on an order as legacy_backfill are
-- excluded here -- one dollar, one bucket.
legacy_freight_agg as (
  select
    customer_id,
    coalesce(sum(amount_cad) filter (where superseded_by_order_ref is null), 0)::numeric(12,2)
                                                                                   as legacy_shipping_cad,
    count(*) filter (where superseded_by_order_ref is null)                        as legacy_shipment_count
  from public.legacy_shipping_costs
  where customer_id is not null
  group by customer_id
),
consumables_agg as (
  select
    customer_id,
    coalesce(sum(public.to_cad(amount, currency)), 0)::numeric(12,2)               as consumables_cost_cad,
    count(*)                                                                       as consumable_item_count
  from public.external_item_costs
  where customer_id is not null
  group by customer_id
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
  -- The order's ship-to beats the CRM record: it is where the machine went,
  -- and it is filled on every sale order. Country is read from whichever
  -- record supplied the region — mixing a CRM country with an order region
  -- invents places like 'US-ON'.
  case
    when fs.first_region is not null then coalesce(fs.first_country, c.country)
    else coalesce(c.country, fs.first_country)
  end                                                                              as country,
  public.normalize_region(coalesce(fs.first_region, c.region))                     as region,
  case
    when public.normalize_region(coalesce(fs.first_region, c.region)) is null then null
    else coalesce(
           case when fs.first_region is not null then coalesce(fs.first_country, c.country)
                else coalesce(c.country, fs.first_country) end, '??')
         || '-' || public.normalize_region(coalesce(fs.first_region, c.region))
  end                                                                              as region_code,
  c.onboard_date,
  public.normalize_channel(
    coalesce(fs.attribution_source, c.first_touch_source),
    coalesce(fs.attribution_medium, c.first_touch_medium)
  )                                                                                as acquisition_channel,
  coalesce(fs.attribution_campaign, c.first_touch_campaign_id)                     as acquisition_campaign,
  fs.first_order_at,
  oa.last_order_at,
  -- Cohort anchor: when we actually won them. The first sale beats onboard_date,
  -- which is set by hand and is often the install visit weeks later.
  coalesce(fs.first_order_at::date, c.onboard_date)                                as acquired_on,
  oa.revenue_cad,
  (oa.revenue_cad + oa.discount_cad)::numeric(12,2)                                as gross_revenue_cad,
  oa.discount_cad,
  coalesce(fs.initial_revenue_cad, 0)::numeric(12,2)                               as initial_revenue_cad,
  coalesce(fs.initial_discount_cad, 0)::numeric(12,2)                              as initial_discount_cad,
  -- Everything bought after the first order: extra units, accessories, parts.
  greatest(oa.revenue_cad - coalesce(fs.initial_revenue_cad, 0), 0)::numeric(12,2) as upsell_revenue_cad,
  oa.tax_collected_cad,
  oa.sale_cogs_cad,
  oa.sale_shipping_cad,
  oa.expected_warranty_cost_cad,
  coalesce(ra.expected_refund_cad, 0)::numeric(12,2)                               as expected_refund_cad,
  sa.support_cost_cad::numeric(12,2)                                               as support_cost_cad,
  (ga.return_stocking_cad + ga.return_inspection_cad + ga.return_freight_cad)::numeric(12,2)
                                                                                   as return_handling_cad,
  ga.return_stocking_cad,
  ga.return_inspection_cad,
  ga.return_freight_cad,
  coalesce(ga.returns_handled, 0)::int                                             as returns_handled,
  -- V9 buckets 7-9. Rated 0 until Finance prices them; the UI says "unpriced"
  -- rather than letting a 0 read as "this costs us nothing".
  (oa.charged_gross_cad * (select payment_fee_pct from rates) / 100)::numeric(12,2)  as payment_fee_cad,
  (oa.revenue_cad * (select commission_pct from rates) / 100)::numeric(12,2)         as sales_commission_cad,
  (oa.order_count * (select install_per_unit from rates))::numeric(12,2)             as installation_cost_cad,
  -- LILA sells no subscription or service plan today, so there is no recurring
  -- revenue stream to read. Held at 0 and surfaced as "not offered", not as a
  -- customer who happens to buy nothing recurring.
  0::numeric(12,2)                                                                 as recurring_revenue_cad,
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
    - (oa.charged_gross_cad * (select payment_fee_pct from rates) / 100)
    - (oa.revenue_cad * (select commission_pct from rates) / 100)
    - (oa.order_count * (select install_per_unit from rates))
    - coalesce(ca.consumables_cost_cad, 0)
    - coalesce(lf.legacy_shipping_cad, 0)
  )::numeric(12,2)                                                                  as net_margin_cad,
  coalesce(ra.settled_refund_cad, 0)::numeric(12,2)                                as settled_refund_cad,
  oa.order_count,
  coalesce(oa.units_shipped_count, 0)::int                                          as units_shipped_count,
  oa.replacement_count,
  oa.open_replacement_count,
  oa.cogs_actual_count,
  oa.cogs_modelled_count,
  oa.shipping_costed_count,
  oa.shipping_uncosted_count,
  coalesce(oa.shipping_invoiced_count, 0)::int                                      as shipping_invoiced_count,
  coalesce(lf.legacy_shipping_cad, 0)::numeric(12,2)                                as legacy_shipping_cad,
  coalesce(lf.legacy_shipment_count, 0)::int                                        as legacy_shipment_count,
  coalesce(ca.consumables_cost_cad, 0)::numeric(12,2)                               as consumables_cost_cad,
  coalesce(ca.consumable_item_count, 0)::int                                        as consumable_item_count,
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
left join first_sale fs on fs.customer_id = c.id
left join refund_agg ra on ra.customer_id = c.id
left join ticket_agg ta on ta.customer_id = c.id
left join support_agg sa on sa.customer_id = c.id
left join return_agg ga on ga.customer_id = c.id
left join consumables_agg ca on ca.customer_id = c.id
left join legacy_freight_agg lf on lf.customer_id = c.id;

alter view public.customer_profitability set (security_invoker = true);

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V13: 10-bucket contribution margin in CAD. Refund approvals are reached '
  'through their return OR, when they have none, by their own customer fields -- an '
  'approval without a return used to be invisible. Freight has three sources: Freightcom '
  'invoices, the synced quote, and pre-Freightcom carrier costs per customer.';
