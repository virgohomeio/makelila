-- Backlog #58 V9 (1/2) — the inputs the profitability model needs but the
-- operational tables never captured: per-unit variable-cost rates we have no
-- invoice for, and acquisition spend by channel.
--
-- Everything here is seeded at 0 on purpose. A rate of 0 means "nobody has
-- priced this yet", and every surface that reads it says so rather than
-- implying the cost is genuinely zero. Fill them in and the whole model —
-- contribution margin, LTV, payback — moves with them.

-- ── Variable-cost rates ─────────────────────────────────────────────────────
-- Same key/value/note shape as support_rates and return_cost_rates so there is
-- one obvious place to look for "what do we charge ourselves for X".
create table if not exists public.profitability_rates (
  key        text primary key,
  value      numeric(12,4) not null,
  unit       text not null,          -- 'pct' | 'cad_per_unit' | 'cad_per_customer' | 'years'
  note       text,
  updated_at timestamptz not null default now()
);

insert into public.profitability_rates (key, value, unit, note) values
  ('payment_fee_pct', 0, 'pct',
   'Payment processing as a share of the gross charged amount (incl. tax). Shopify/Sezzle/QuickBooks blended. 0 = not yet priced.'),
  ('sales_commission_pct', 0, 'pct',
   'Sales commission as a share of net revenue on a sale order. 0 = not yet priced.'),
  ('installation_cost_per_unit_cad', 0, 'cad_per_unit',
   'Labour + travel + materials to install one unit. LILA ships self-install today, so 0 is also the true value until that changes.'),
  ('recurring_revenue_per_customer_month_cad', 0, 'cad_per_customer',
   'Monthly recurring revenue per active customer. 0 = LILA has no subscription or service-plan product yet.'),
  ('projected_lifetime_years', 5, 'years',
   'Assumed customer lifetime used for projected LTV. An assumption, not an observation — LILA has no churn history long enough to fit one.')
on conflict (key) do nothing;

alter table public.profitability_rates enable row level security;

drop policy if exists profitability_rates_read on public.profitability_rates;
create policy profitability_rates_read on public.profitability_rates
  for select to authenticated using (true);

grant select on public.profitability_rates to authenticated;

comment on table public.profitability_rates is
  'Variable-cost rates and projection assumptions for the customer profitability model. '
  'A value of 0 means unpriced, not free — the UI labels it as such.';

/** One rate by key, or null when it is not on file. */
create or replace function public.profitability_rate(p_key text)
returns numeric
language sql
stable
as $$
  select value from public.profitability_rates where key = p_key;
$$;

-- ── Acquisition spend ───────────────────────────────────────────────────────
-- CAC needs spend by channel by month. Meta spend is already synced into
-- fb_campaigns; every other channel has to be entered by hand, so this table
-- holds those and starts empty (i.e. $0 for organic/direct/referral/email).
create table if not exists public.acquisition_spend_manual (
  id         uuid primary key default gen_random_uuid(),
  channel    text not null,
  month      date not null,          -- first of the month
  spend_cad  numeric(12,2) not null default 0,
  note       text,
  updated_at timestamptz not null default now(),
  unique (channel, month)
);

alter table public.acquisition_spend_manual enable row level security;

drop policy if exists acquisition_spend_manual_read on public.acquisition_spend_manual;
create policy acquisition_spend_manual_read on public.acquisition_spend_manual
  for select to authenticated using (true);

grant select on public.acquisition_spend_manual to authenticated;

comment on table public.acquisition_spend_manual is
  'Hand-entered acquisition spend by channel and month, for channels with no API sync. '
  'Meta spend comes from fb_campaigns and must NOT be duplicated here.';

-- Meta campaign spend is booked to the month the flight started. Campaigns
-- that straddle a month boundary are not pro-rated — the flights are short and
-- pro-rating would imply a precision the daily data does not have.
create or replace view public.acquisition_spend_monthly as
  select
    'paid_social'::text                             as channel,
    date_trunc('month', date_start)::date           as month,
    sum(spend_cad)::numeric(12,2)                   as spend_cad,
    'fb_campaigns'::text                            as source
  from public.fb_campaigns
  where date_start is not null and spend_cad is not null
  group by 2
  union all
  select channel, month, spend_cad, 'manual'::text
  from public.acquisition_spend_manual;

alter view public.acquisition_spend_monthly set (security_invoker = true);

grant select on public.acquisition_spend_monthly to authenticated;

comment on view public.acquisition_spend_monthly is
  'Acquisition spend by channel and month: Meta from fb_campaigns, everything else hand-entered. '
  'A channel with no row spent nothing we can trace, which is not the same as spending nothing.';
