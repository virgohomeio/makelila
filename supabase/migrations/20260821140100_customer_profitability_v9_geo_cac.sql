-- Backlog #58 V9 (2/2) — the profitability model grows past "what did this
-- customer cost us" into "which customers, channels and places are worth
-- acquiring".
--
-- Three things change:
--   1. Geography drops below country. Every sale order carries region_state
--      (215/215 of them), so province/state is a real dimension, not a guess.
--      region_code is 'CA-ON' / 'US-CA' — the country prefix matters, because
--      'CA' alone is Canada in one column and California in the other.
--   2. Acquisition channel and cohort come off the order's UTM attribution,
--      falling back to the customer's first-touch source.
--   3. Three more variable-cost buckets — payment fees, sales commission,
--      installation — priced from public.profitability_rates. All three are
--      rated 0 today, so net_margin_cad does not move; the columns exist so
--      that filling a rate in is the only thing anyone has to do.
--
-- CAC is deliberately NOT in this view. It is an allocation of channel spend
-- across the customers a channel acquired in a month, which needs the whole
-- cohort in hand — see lib/profitability.ts, where it is computed and tested.

-- ── Region normaliser ───────────────────────────────────────────────────────
-- Shopify hands us 'ON' on some orders and 'Ontario' on others. Fold both to
-- the two-letter code so a province is one row in the comparison, not two.
create or replace function public.normalize_region(p_region text)
returns text
language sql
immutable
as $$
  select case
    when p_region is null or btrim(p_region) = '' then null
    when length(btrim(p_region)) = 2 then upper(btrim(p_region))
    else coalesce(
      (select code from (values
        ('alberta','AB'), ('british columbia','BC'), ('manitoba','MB'),
        ('new brunswick','NB'), ('newfoundland and labrador','NL'),
        ('newfoundland','NL'), ('northwest territories','NT'),
        ('nova scotia','NS'), ('nunavut','NU'), ('ontario','ON'),
        ('prince edward island','PE'), ('quebec','QC'), ('québec','QC'),
        ('saskatchewan','SK'), ('yukon','YT'),
        ('alabama','AL'), ('alaska','AK'), ('arizona','AZ'), ('arkansas','AR'),
        ('california','CA'), ('colorado','CO'), ('connecticut','CT'),
        ('delaware','DE'), ('district of columbia','DC'), ('florida','FL'),
        ('georgia','GA'), ('hawaii','HI'), ('idaho','ID'), ('illinois','IL'),
        ('indiana','IN'), ('iowa','IA'), ('kansas','KS'), ('kentucky','KY'),
        ('louisiana','LA'), ('maine','ME'), ('maryland','MD'),
        ('massachusetts','MA'), ('michigan','MI'), ('minnesota','MN'),
        ('mississippi','MS'), ('missouri','MO'), ('montana','MT'),
        ('nebraska','NE'), ('nevada','NV'), ('new hampshire','NH'),
        ('new jersey','NJ'), ('new mexico','NM'), ('new york','NY'),
        ('north carolina','NC'), ('north dakota','ND'), ('ohio','OH'),
        ('oklahoma','OK'), ('oregon','OR'), ('pennsylvania','PA'),
        ('rhode island','RI'), ('south carolina','SC'), ('south dakota','SD'),
        ('tennessee','TN'), ('texas','TX'), ('utah','UT'), ('vermont','VT'),
        ('virginia','VA'), ('washington','WA'), ('west virginia','WV'),
        ('wisconsin','WI'), ('wyoming','WY')
      ) as m(name, code) where m.name = lower(btrim(p_region))),
      upper(btrim(p_region))
    )
  end;
$$;

comment on function public.normalize_region(text) is
  'Fold a province/state to its two-letter code. Unknown long names pass through uppercased.';

-- ── Channel normaliser ──────────────────────────────────────────────────────
-- Collapses raw UTM source/medium into the small set of channels we actually
-- budget against, and that acquisition_spend_monthly.channel keys on.
create or replace function public.normalize_channel(p_source text, p_medium text)
returns text
language sql
immutable
as $$
  select case
    when p_source is null and p_medium is null then 'unknown'
    when lower(coalesce(p_medium,'')) in ('paid','cpc','ppc','paid_social') then 'paid_social'
    when lower(coalesce(p_medium,'')) = 'social'   then 'organic_social'
    when lower(coalesce(p_medium,'')) = 'organic'  then 'organic_search'
    when lower(coalesce(p_medium,'')) = 'email'    then 'email'
    when lower(coalesce(p_medium,'')) = 'direct'   then 'direct'
    when lower(coalesce(p_source,'')) = 'shopify_direct' then 'direct'
    when lower(coalesce(p_medium,'')) = 'referral' then 'referral'
    when lower(coalesce(p_source,'')) in ('facebook','fb','ig','instagram') then 'organic_social'
    else 'other'
  end;
$$;

comment on function public.normalize_channel(text, text) is
  'Collapse UTM source/medium into a budgetable acquisition channel. Keys match acquisition_spend_monthly.channel.';

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
    o.attribution_source,
    o.attribution_medium,
    o.attribution_campaign,
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
    coalesce(sum(public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD')))
             filter (where kind = 'sale'), 0)::numeric(12,2)                       as sale_shipping_cad,
    coalesce(sum(
      coalesce(public.to_cad(cogs_usd, 'USD'), 0)
      + coalesce(public.to_cad(shipping_cost_usd, coalesce(shipping_cost_currency, 'CAD')), 0)
    ) filter (where kind = 'replacement' and status <> 'cancelled'), 0)::numeric(12,2)
                                                                                   as expected_warranty_cost_cad,
    max(placed_at) filter (where kind = 'sale')                                     as last_order_at,
    count(*) filter (where order_id is not null and kind = 'sale')                  as order_count,
    count(*) filter (where order_id is not null and kind = 'sale'
                     and order_shipped)                                             as units_shipped_count,
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
left join return_agg ga on ga.customer_id = c.id;

alter view public.customer_profitability set (security_invoker = true);

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V9: 9-bucket contribution margin in CAD (COGS, freight, warranty, '
  'refunds, diagnosis-call labour, return handling, payment fees, sales commission, '
  'installation) plus province/state, acquisition channel and cohort anchor. '
  'CAC and LTV are allocated in lib/profitability.ts, not here.';
