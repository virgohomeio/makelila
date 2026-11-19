-- Backlog #58 V5 / #65 — put customer profitability on a single CAD basis.
--
-- The V4 view summed four columns that are each denominated differently, then
-- the tab formatted the result as USD. Nothing in the pipeline converted
-- anything. The actual currency of each input:
--
--   orders.total_usd, orders.tax_usd   → orders.currency (119 CAD / 92 USD)
--   orders.cogs_usd                    → USD, always (both the V-SAX roadmap
--                                        schedule and batches.unit_cost_usd are
--                                        quoted in USD regardless of the order)
--   orders.shipping_cost_usd           → shipping_cost_currency, CAD on every
--                                        row (see 20260806170000)
--   refund_approvals.refund_amount_usd → refund_approvals.currency (7 USD/3 CAD)
--
-- So a customer's "net margin" was CAD revenue minus USD cost of goods minus CAD
-- freight, printed with a USD label. Per-customer cards were roughly right for
-- single-currency customers; the summary bar and the avg-margin-by-country
-- insight were adding CAD to USD outright.
--
-- V5 converts every input to CAD through one rate table and renames the output
-- columns to _cad so a stale caller fails loudly instead of silently
-- misreporting. Operator decision (Huayi, 2026-08-12): report in CAD — it is the
-- majority of orders and all freight is already CAD.
--
-- The rate lives in a table, not a constant, so correcting it is an UPDATE
-- rather than a migration. fx_rates is readable by any internal user because
-- customer_profitability is security_invoker (20260607120000) and every
-- operator needs the view; finance_config would have been wrong here since its
-- RLS is finance-only and non-finance operators would silently get NULL margins.
--
-- Single company rate, not rate-at-order-date. A per-date rate is the more
-- correct model for revenue recognition; it needs a rate history we do not have
-- and is a separate item.

-- ── Rate table ──────────────────────────────────────────────────────────────

create table if not exists public.fx_rates (
  base       text not null,
  quote      text not null,
  rate       numeric(12,6) not null check (rate > 0),
  note       text,
  updated_at timestamptz not null default now(),
  primary key (base, quote)
);

comment on table public.fx_rates is
  'Company reporting FX rates. rate = how many units of `quote` one unit of '
  '`base` buys. Operator-maintained; update the row rather than migrating.';

alter table public.fx_rates enable row level security;

drop policy if exists fx_rates_select on public.fx_rates;
create policy fx_rates_select on public.fx_rates
  for select using (public.is_internal_user());

drop policy if exists fx_rates_write on public.fx_rates;
create policy fx_rates_write on public.fx_rates
  for update using (public.is_manager());

grant select on public.fx_rates to authenticated;

-- Huayi, 2026-08-12: "most recent CAD rate: 1 CAD = 0.72 USD" → USD→CAD is the
-- reciprocal, 1/0.72 = 1.388889.
insert into public.fx_rates (base, quote, rate, note) values
  ('USD', 'CAD', 1.388889, 'Reciprocal of 1 CAD = 0.72 USD, per Huayi 2026-08-12'),
  ('CAD', 'CAD', 1.000000, 'Identity'),
  ('USD', 'USD', 1.000000, 'Identity')
on conflict (base, quote) do update
  set rate = excluded.rate, note = excluded.note, updated_at = now();

-- Converts to CAD. An unknown currency returns NULL rather than silently
-- passing the amount through at 1:1, so a new currency surfaces as a gap
-- instead of a wrong number.
create or replace function public.to_cad(amount numeric, currency text)
returns numeric
language sql
stable
as $$
  select case
    when amount is null then null
    else (amount * (select r.rate from public.fx_rates r
                    where r.base = coalesce(currency, 'CAD') and r.quote = 'CAD'))::numeric(12,2)
  end;
$$;

comment on function public.to_cad(numeric, text) is
  'Converts an amount in `currency` to CAD using public.fx_rates. Returns NULL '
  'for an unknown currency so gaps surface rather than pass through at 1:1.';

-- ── V5 view ─────────────────────────────────────────────────────────────────

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
  (
    oa.revenue_cad
    - oa.sale_cogs_cad
    - oa.sale_shipping_cad
    - oa.expected_warranty_cost_cad
    - coalesce(ra.expected_refund_cad, 0)
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
  exists (
    select 1 from public.team_invite_list t
    where lower(t.display_name) = lower(c.full_name)
       or lower(c.full_name) like lower(t.display_name) || ' %'
  )                                                                                 as is_team_member
from public.customers c
left join order_agg oa on oa.customer_id = c.id
left join refund_agg ra on ra.customer_id = c.id
left join ticket_agg ta on ta.customer_id = c.id;

alter view public.customer_profitability set (security_invoker = true);

grant select on public.customer_profitability to authenticated;

comment on view public.customer_profitability is
  'Backlog #58 V5: 4-bucket profitability, every amount converted to CAD via '
  'public.fx_rates. Columns are _cad — V4''s _usd names were a misnomer on '
  'three of the four inputs. cogs_actual_count / cogs_modelled_count and '
  'shipping_costed_count / shipping_uncosted_count expose how much of the cost '
  'side is measured vs projected.';
