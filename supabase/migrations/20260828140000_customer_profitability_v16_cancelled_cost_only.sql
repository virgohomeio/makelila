-- Backlog #58 V16 -- a cancelled order keeps its revenue and loses its cost.
--
-- CORRECTS V15 (Huayi, 2026-08-28). V15 took a cancelled order's revenue out of
-- the customer. That broke the refund: the approval that reversed the sale was
-- still booked as a cost, so the reversal was counted twice and five customers'
-- margins overstated the loss by $6,547.69.
--
-- The right shape is simpler, and it is how the business actually works:
--
--   * REVENUE STAYS. A cancelled order was a sale. It counts, exactly as it did
--     before V15, and the refund subtracts it through bucket 4. One reversal,
--     not two. Net zero for a cancellation that was refunded in full.
--   * COST LEAVES. LILA keeps the machine, so its COGS and freight do not
--     belong to the person who cancelled. They move to
--     public.retained_unit_costs -- company-level, carried by nobody in
--     particular, and shown on the tab OUTSIDE contribution margin.
--
-- So the only thing V16 excludes is cost. Revenue, discount, tax, charged gross,
-- order count and first-sale attribution all revert to V14 behaviour. The
-- cost-basis counts (cogs_actual, cogs_modelled, shipping_costed,
-- shipping_invoiced) go with the cost they describe.
--
-- TEST ORDERS ARE NOT RETAINED MACHINES. Seven of the twenty cancelled orders
-- were placed on Pedrum's internal account -- #1013, #1014, #1089, #1101, #1105,
-- #1106, #1193 -- and are confirmed tests. No machine was built, so there is
-- nothing to retain: retained_unit_costs now excludes team accounts outright
-- rather than flagging them. The line falls from $15,556.44 to $9,503.66 across
-- the 13 real cancellations.
--
-- KNOWN RESIDUAL. Three customers have a cancelled order with no refund on file
-- -- I-Scott Campbell $1,199.99, Juanita Wells $1,099.99, Matthew Lypkie $68.74
-- -- so $2,368.72 of revenue now counts with nothing reversing it and no COGS
-- against it. Either the refund record is missing (which is the same gap as the
-- 16 refunded orders with no approval row) or the money was never collected.
-- Not guessed at here.

drop view if exists public.customer_profitability;

create view public.customer_profitability as
with rates as (
  select
    coalesce(public.profitability_rate('payment_fee_pct'), 0)                as payment_fee_pct,
    coalesce(public.profitability_rate('sales_commission_pct'), 0)           as commission_pct,
    coalesce(public.profitability_rate('installation_cost_per_unit_cad'), 0) as install_per_unit,
    coalesce(public.profitability_rate('fulfilment_order_fee_cad'), 0)       as ff_order,
    coalesce(public.profitability_rate('fulfilment_first_pick_cad'), 0)      as ff_first,
    coalesce(public.profitability_rate('fulfilment_additional_pick_cad'), 0) as ff_addl,
    -- Unset defaults to 9999-12-31, i.e. charge nobody. A 3PL fee applied to
    -- orders that predate the contract would be an invention.
    to_date(coalesce(public.profitability_rate('fulfilment_effective_from_yyyymmdd'), 99991231)::bigint::text,
            'YYYYMMDD')                                                      as ff_from
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
    -- V16. Cancelled means LILA kept the machine. Only the COST aggregates
    -- below exclude these -- revenue stays, and the refund reverses it once.
    (coalesce(o.status, '') = 'cancelled'
     or o.cancelled_at is not null)                          as order_cancelled,
    -- Bucket 11: 3PL per-order handling (FlexSpace). Order fee + first pick +
    -- an additional pick for every item beyond the first.
    --
    -- ESTIMATED, not actual: contracted rates off the rate card, with no
    -- FlexSpace invoice in this database to reconcile against.
    --
    -- Transportation is deliberately NOT here. The rate card passes carrier
    -- cost straight through, and that freight is already bucket 2 via
    -- Freightcom -- charging it again would bill every shipment twice.
    --
    -- A cancelled order was never picked, so it owes nothing.
    case
      when o.id is null or o.placed_at is null then null
      when o.placed_at < (select ff_from from rates) then 0
      when coalesce(o.status,'') = 'cancelled' or o.cancelled_at is not null then 0
      else (select ff_order from rates) + (select ff_first from rates)
           + (select ff_addl from rates)
             * greatest((select coalesce(sum((li->>'qty')::numeric), 1)
                           from jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) li) - 1, 0)
    end::numeric(12,2)                                       as fulfilment_cost_cad,
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
    -- The machine came back to stock, so its build cost is not this
    -- customer's. It is on public.retained_unit_costs instead.
    coalesce(sum(public.to_cad(cogs_usd, 'USD'))
             filter (where kind = 'sale' and not order_cancelled), 0)::numeric(12,2)
                                                                                   as sale_cogs_cad,
    -- Invoiced beats quoted. shipments.billed_amount (which orders.shipping_cost_usd
    -- was populated from) is the ORIGINAL QUOTE and is never revised, so the four
    -- batch fuel-surcharge invoices Freightcom raised later were invisible.
    coalesce(sum(coalesce(
      invoiced_freight_cad,
      public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD'))
    )) filter (where kind = 'sale' and not order_cancelled), 0)::numeric(12,2)
                                                                                   as sale_shipping_cad,
    count(*) filter (where kind = 'sale' and not order_cancelled
                     and invoiced_freight_cad is not null)                         as shipping_invoiced_count,
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
    count(*) filter (where kind = 'sale' and not order_cancelled
                     and cogs_basis = 'batch_actual')                              as cogs_actual_count,
    count(*) filter (where kind = 'sale' and not order_cancelled
                     and cogs_basis = 'schedule')                                  as cogs_modelled_count,
    count(*) filter (where kind = 'sale' and not order_cancelled
                     and shipping_cost_usd is not null)                            as shipping_costed_count,
    -- A cancelled order never shipped, so it owes no freight and must not
    -- sit in the gap. (Revenue and COGS still count cancelled sale orders --
    -- that is a separate question, tracked on its own.) An order with an
    -- invoice on file is costed even when the synced quote is null.
    count(*) filter (where order_id is not null and kind = 'sale'
                     and shipping_cost_usd is null
                     and invoiced_freight_cad is null
                     and order_shipped
                     and coalesce(status, '') <> 'cancelled'
                     and cancelled_at is null)                                      as shipping_uncosted_count,
    -- Sale and replacement orders alike: the 3PL picks and packs both.
    coalesce(sum(fulfilment_cost_cad) filter (where order_id is not null
             and kind in ('sale','replacement')), 0)::numeric(12,2)                 as fulfilment_cost_cad,
    count(*) filter (where order_id is not null
                     and coalesce(fulfilment_cost_cad, 0) > 0)                      as fulfilment_order_count
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
    - coalesce(oa.fulfilment_cost_cad, 0)
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
  coalesce(oa.fulfilment_cost_cad, 0)::numeric(12,2)                                as fulfilment_cost_cad,
  coalesce(oa.fulfilment_order_count, 0)::int                                       as fulfilment_order_count,
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
  'Backlog #58 V16: 11-bucket contribution margin in CAD. A cancelled sale order keeps its '
  'revenue -- the refund reverses it once, through bucket 4 -- but loses its COGS and '
  'freight, because LILA retained the machine. That cost moves to '
  'public.retained_unit_costs and is reported company-wide, outside contribution margin. '
  'Corrects V15, which removed the revenue too and so counted the reversal twice.';


-- ---------------------------------------------------------------------------
-- Where a cancelled order's cost goes.
--
-- One row per cancelled sale order that represents a real machine: the unit
-- LILA built and kept, plus the freight if it had already gone out. No
-- customer_id on purpose -- nobody in particular carries this.
--
-- Team accounts are excluded outright. Pedrum's seven cancelled orders are
-- confirmed test data, and no machine was ever built for them, so there is no
-- retained unit to cost. Including them would invent $6,052.78.
--
-- Freight uses the same per-shipment coalesce as the main view: the invoiced
-- charge where Freightcom has raised one, the synced quote otherwise, and zero
-- when the order never shipped.
drop view if exists public.retained_unit_costs;

create view public.retained_unit_costs as
select
  o.id                                                              as order_id,
  o.order_ref,
  o.customer_name,
  o.placed_at,
  o.cancelled_at,
  o.cogs_basis,
  coalesce(public.to_cad(o.cogs_usd, 'USD'), 0)::numeric(12,2)      as cogs_cad,
  coalesce(
    (select sum(coalesce(sic.applicable_cad, s.billed_amount))
       from public.shipments s
       left join public.shipment_invoiced_charges sic
         on sic.tracking_number = s.primary_tracking_number
      where s.order_id = o.id),
    public.to_cad(o.shipping_cost_usd, coalesce(o.shipping_cost_currency, 'CAD')),
    0
  )::numeric(12,2)                                                  as freight_cad,
  (select coalesce(sum((li->>'qty')::numeric), 1)
     from jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) li)::int
                                                                    as units_retained
from public.orders o
where o.kind = 'sale'
  and (coalesce(o.status, '') = 'cancelled' or o.cancelled_at is not null)
  and not exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(o.customer_name)
       or lower(o.customer_name) like lower(t.display_name) || ' %'
  );

alter view public.retained_unit_costs set (security_invoker = true);

grant select on public.retained_unit_costs to authenticated;

comment on view public.retained_unit_costs is
  'Backlog #58 V16: cost of machines built for orders that were later cancelled. LILA kept '
  'the unit, so this cost belongs to no customer -- it is reported company-wide, outside '
  'contribution margin. Team accounts are excluded: those cancellations are test orders '
  'with no machine behind them.';
