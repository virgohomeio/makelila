/** Customer profitability model — every formula in one auditable place.
 *
 *  The `customer_profitability` view does the per-customer aggregation in SQL.
 *  Everything that needs more than one customer in hand lives here: CAC, which
 *  is an allocation of channel spend across the cohort that channel won; the
 *  segment, geography and cohort rollups; and the distribution buckets the
 *  dashboard charts.
 *
 *  Three rules this module holds to, because the numbers get quoted:
 *
 *  1. **Nothing is invented.** A cost we have never priced comes back with a
 *     basis of 'unpriced' next to its zero, and every caller is expected to
 *     say so. A metric with no data at all returns null, not 0.
 *  2. **No double counting.** Each dollar of cost belongs to exactly one
 *     bucket. The nine buckets sum to variable cost and nothing else adds in.
 *  3. **Realized and projected never mix.** Realized LTV is margin banked to
 *     date. Projected LTV adds an explicitly-flagged assumption on top, and
 *     the two are separate fields so a chart cannot blur them.
 *
 *  See docs/profitability-model.md for the formula-by-formula write-up.
 */

import type { CustomerProfitability } from './customers';
import { regionName } from './regions';

// ── Rates and assumptions ───────────────────────────────────────────────────

/** Mirrors public.profitability_rates. Values are read from the DB; these
 *  defaults only stand in when the table has not loaded yet. */
export type ProfitabilityRates = {
  payment_fee_pct: number;
  sales_commission_pct: number;
  installation_cost_per_unit_cad: number;
  recurring_revenue_per_customer_month_cad: number;
  projected_lifetime_years: number;
};

export const DEFAULT_RATES: ProfitabilityRates = {
  payment_fee_pct: 0,
  sales_commission_pct: 0,
  installation_cost_per_unit_cad: 0,
  recurring_revenue_per_customer_month_cad: 0,
  projected_lifetime_years: 5,
};

/** A rate of 0 is ambiguous: unpriced, or genuinely free? Only Finance knows,
 *  so the UI labels a zero rate "unpriced" and stops short of claiming the
 *  cost is nil. The one exception is installation, which really is zero while
 *  LILA ships self-install — that judgement lives in the rate's own note. */
export function isUnpriced(rate: number | null | undefined): boolean {
  return rate == null || rate === 0;
}

// ── Acquisition spend and CAC ───────────────────────────────────────────────

export type AcquisitionSpendRow = {
  channel: string;
  month: string;       // 'YYYY-MM-DD', first of month
  spend_cad: number;
  source: string;
};

export const CHANNEL_LABELS: Record<string, string> = {
  paid_social:    'Paid social',
  organic_search: 'Organic search',
  organic_social: 'Organic social',
  referral:       'Referral',
  direct:         'Direct',
  email:          'Email',
  other:          'Other',
  unknown:        'Unattributed',
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return CHANNEL_LABELS.unknown;
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Why a customer's CAC is the number it is. The dashboard shows this next to
 *  the figure so nobody reads an allocation as an invoice. */
export type CacBasis =
  | 'allocated'   // real spend, divided across the customers it won
  | 'no_spend'    // channel had no traceable spend that month — booked at $0
  | 'unknown';    // no acquisition date, so no month to allocate from

export type CacAllocation = { cac_cad: number | null; basis: CacBasis };

/** 'YYYY-MM' for a date string, or null when it is missing or unparseable. */
export function monthKey(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function quarterKey(date: string | null | undefined): string | null {
  const mk = monthKey(date);
  if (!mk) return null;
  const [y, m] = mk.split('-');
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

export type CacAllocationResult = {
  /** customer id → what that customer cost to acquire */
  byCustomer: Map<string, CacAllocation>;
  /** Spend in channel-months that won nobody. Real money that no customer
   *  carries, so it must be reported rather than quietly dropped. */
  unallocatedSpendCad: number;
  /** Channel-months where customers arrived but no spend is on file. */
  unpricedChannelMonths: string[];
};

/** Allocate acquisition spend across the customers each channel won.
 *
 *      CAC(customer) = spend(channel, month) / customers acquired(channel, month)
 *
 *  Spend is matched to the month a customer placed their first order, on the
 *  channel that order was attributed to. It is an even split within the
 *  channel-month: we have no per-customer ad cost, and pretending otherwise
 *  would be precision we did not buy.
 */
export function allocateCac(
  rows: CustomerProfitability[],
  spend: AcquisitionSpendRow[],
): CacAllocationResult {
  const spendByKey = new Map<string, number>();
  for (const s of spend) {
    const mk = monthKey(s.month);
    if (!mk) continue;
    const key = `${s.channel}|${mk}`;
    spendByKey.set(key, (spendByKey.get(key) ?? 0) + (s.spend_cad ?? 0));
  }

  // Team accounts never cost anything to acquire, and letting them absorb a
  // share of the spend would deflate every real customer's CAC.
  const acquirable = rows.filter(r => !r.is_team_member);

  const cohortCounts = new Map<string, number>();
  for (const r of acquirable) {
    const mk = monthKey(r.acquired_on);
    if (!mk) continue;
    const key = `${r.acquisition_channel ?? 'unknown'}|${mk}`;
    cohortCounts.set(key, (cohortCounts.get(key) ?? 0) + 1);
  }

  const byCustomer = new Map<string, CacAllocation>();
  const unpriced = new Set<string>();
  for (const r of acquirable) {
    const mk = monthKey(r.acquired_on);
    if (!mk) {
      byCustomer.set(r.id, { cac_cad: null, basis: 'unknown' });
      continue;
    }
    const key = `${r.acquisition_channel ?? 'unknown'}|${mk}`;
    const monthSpend = spendByKey.get(key);
    const n = cohortCounts.get(key) ?? 0;
    if (monthSpend == null || n === 0) {
      unpriced.add(key);
      byCustomer.set(r.id, { cac_cad: 0, basis: 'no_spend' });
      continue;
    }
    byCustomer.set(r.id, { cac_cad: monthSpend / n, basis: 'allocated' });
  }

  let unallocated = 0;
  for (const [key, amount] of spendByKey) {
    if ((cohortCounts.get(key) ?? 0) === 0) unallocated += amount;
  }

  return {
    byCustomer,
    unallocatedSpendCad: unallocated,
    unpricedChannelMonths: Array.from(unpriced).sort(),
  };
}

// ── Per-customer metrics ────────────────────────────────────────────────────

export type PaybackStatus =
  | 'immediate'      // the sale itself covered CAC
  | 'not_recovered'  // margin to date is still short of CAC
  | 'no_cac'         // nothing was spent to win them
  | 'unknown';       // CAC could not be established

export type CacPayback = {
  status: PaybackStatus;
  /** Months to recover CAC. 0 when the first sale covered it; null when there
   *  is no recurring revenue to project a recovery from. */
  months: number | null;
  recoveredCad: number;
  remainingCad: number;
};

export type CustomerMetrics = {
  id: string;
  name: string;
  // Revenue
  revenue: number;
  grossRevenue: number;
  discount: number;
  /** null when there is no revenue to take a share of. */
  discountRate: number | null;
  initialRevenue: number;
  upsellRevenue: number;
  recurringRevenue: number;
  // Cost buckets — these nine and no others sum to variableCosts.
  costs: {
    cogs: number;
    shipping: number;
    warranty: number;
    refunds: number;
    support: number;
    returnHandling: number;
    paymentFees: number;
    commission: number;
    installation: number;
  };
  variableCosts: number;
  contributionMargin: number;
  contributionMarginPct: number | null;
  // Acquisition and lifetime
  cac: number | null;
  cacBasis: CacBasis;
  realizedLtv: number;
  projectedLtv: number;
  ltvCac: number | null;
  lifetimeProfit: number;
  payback: CacPayback;
  // Context
  units: number;
  arpu: number | null;
  tenureDays: number | null;
  cohortMonth: string | null;
  channel: string;
  regionCode: string | null;
  country: string | null;
};

/** Every cost we can attribute to this customer, one bucket each.
 *  A null support or return-handling cost means the rate is unset — counted as
 *  0 here so the arithmetic works, and flagged by `costCoverage` so the UI can
 *  say the margin is an upper bound. */
export function variableCosts(row: CustomerProfitability): CustomerMetrics['costs'] {
  return {
    cogs:           row.sale_cogs_cad ?? 0,
    shipping:       row.sale_shipping_cad ?? 0,
    warranty:       row.expected_warranty_cost_cad ?? 0,
    refunds:        row.expected_refund_cad ?? 0,
    support:        row.support_cost_cad ?? 0,
    returnHandling: row.return_handling_cad ?? 0,
    paymentFees:    row.payment_fee_cad ?? 0,
    commission:     row.sales_commission_cad ?? 0,
    installation:   row.installation_cost_cad ?? 0,
  };
}

export function sumCosts(costs: CustomerMetrics['costs']): number {
  return costs.cogs + costs.shipping + costs.warranty + costs.refunds
       + costs.support + costs.returnHandling + costs.paymentFees
       + costs.commission + costs.installation;
}

/** Whole days between two dates, or null if either is missing. */
function daysBetween(from: string | null | undefined, to: Date): number | null {
  if (!from) return null;
  const t = new Date(from).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((to.getTime() - t) / 86_400_000);
}

/**
 *  CAC payback: how long until cumulative contribution margin covers CAC.
 *
 *  LILA sells a machine once and nothing after it, so a customer's whole
 *  contribution arrives at the sale. That makes payback binary today — either
 *  the sale covered acquisition or nothing later will — and `months` stays
 *  null in the shortfall case rather than projecting a recovery from a
 *  recurring revenue stream that does not exist. Once there is a subscription,
 *  this is the function that changes.
 */
export function cacPayback(contributionMargin: number, cac: number | null): CacPayback {
  if (cac == null) {
    return { status: 'unknown', months: null, recoveredCad: 0, remainingCad: 0 };
  }
  if (cac === 0) {
    return { status: 'no_cac', months: 0, recoveredCad: 0, remainingCad: 0 };
  }
  if (contributionMargin >= cac) {
    return { status: 'immediate', months: 0, recoveredCad: cac, remainingCad: 0 };
  }
  return {
    status: 'not_recovered',
    months: null,
    recoveredCad: Math.max(contributionMargin, 0),
    remainingCad: cac - Math.max(contributionMargin, 0),
  };
}

/** Projected lifetime value: margin banked so far, plus whatever the recurring
 *  revenue assumption says is still to come. With the recurring rate at 0 this
 *  equals realized LTV — deliberately, so the dashboard never shows a
 *  projection that is really just a guess dressed up as growth. */
export function projectedLtv(
  contributionMargin: number,
  tenureDays: number | null,
  rates: ProfitabilityRates,
): number {
  const monthly = rates.recurring_revenue_per_customer_month_cad;
  if (!monthly) return contributionMargin;
  const monthsElapsed = tenureDays == null ? 0 : Math.max(tenureDays / 30.44, 0);
  const monthsRemaining = Math.max(rates.projected_lifetime_years * 12 - monthsElapsed, 0);
  return contributionMargin + monthly * monthsRemaining;
}

export function customerMetrics(
  row: CustomerProfitability,
  cac: CacAllocation | undefined,
  rates: ProfitabilityRates = DEFAULT_RATES,
  now: Date = new Date(),
): CustomerMetrics {
  const costs = variableCosts(row);
  const totalCosts = sumCosts(costs);
  const revenue = row.revenue_cad ?? 0;
  // Trust the view's margin: it is the number every other surface quotes, and
  // recomputing it here would let the two drift apart.
  const contributionMargin = row.net_margin_cad ?? revenue - totalCosts;
  const cacValue = cac?.cac_cad ?? null;
  const tenureDays = daysBetween(row.acquired_on, now);
  const units = row.order_count ?? 0;
  const realized = contributionMargin;

  return {
    id: row.id,
    name: row.full_name,
    revenue,
    grossRevenue: row.gross_revenue_cad ?? revenue,
    discount: row.discount_cad ?? 0,
    discountRate: (row.gross_revenue_cad ?? 0) > 0
      ? (row.discount_cad ?? 0) / (row.gross_revenue_cad ?? 1)
      : null,
    initialRevenue: row.initial_revenue_cad ?? 0,
    upsellRevenue: row.upsell_revenue_cad ?? 0,
    recurringRevenue: row.recurring_revenue_cad ?? 0,
    costs,
    variableCosts: totalCosts,
    contributionMargin,
    contributionMarginPct: revenue > 0 ? contributionMargin / revenue : null,
    cac: cacValue,
    cacBasis: cac?.basis ?? 'unknown',
    realizedLtv: realized,
    projectedLtv: projectedLtv(contributionMargin, tenureDays, rates),
    // A ratio against zero spend is not infinity, it is undefined. Null keeps
    // it out of averages instead of poisoning them.
    ltvCac: cacValue != null && cacValue > 0 ? realized / cacValue : null,
    lifetimeProfit: contributionMargin - (cacValue ?? 0),
    payback: cacPayback(contributionMargin, cacValue),
    units,
    arpu: units > 0 ? revenue / units : null,
    tenureDays,
    cohortMonth: monthKey(row.acquired_on),
    channel: row.acquisition_channel ?? 'unknown',
    regionCode: row.region_code,
    country: row.country,
  };
}

/** Which of this customer's costs are known to be incomplete. The margin is an
 *  upper bound whenever any of these is true. */
export function costCoverage(row: CustomerProfitability): {
  complete: boolean;
  gaps: string[];
} {
  const gaps: string[] = [];
  if (row.shipping_uncosted_count > 0) {
    // "Appear to have shipped": the view answers this at customer level, since
    // units.customer_order_ref is too sparse to answer it per order. A repeat
    // buyer can over-count. Word it as evidence, not as a fact we traced.
    gaps.push(`${row.shipping_uncosted_count} order(s) that appear to have shipped with no freight invoice`);
  }
  if (row.cogs_modelled_count > 0) {
    gaps.push(`${row.cogs_modelled_count} order(s) costed from the roadmap projection, not an invoice`);
  }
  if (row.support_cost_cad == null && row.diagnosis_call_count > 0) {
    gaps.push('diagnosis-call labour is unpriced');
  }
  if (row.returns_handled > 0 && !row.return_freight_cad) {
    gaps.push('no return-leg freight on file');
  }
  return { complete: gaps.length === 0, gaps };
}

// ── Rollups ─────────────────────────────────────────────────────────────────

export type SegmentMetrics = {
  key: string;
  label: string;
  customers: number;
  units: number;
  revenue: number;
  grossRevenue: number;
  discount: number;
  discountRate: number | null;
  variableCosts: number;
  contributionMargin: number;
  contributionMarginPct: number | null;
  /** Total spend allocated to this segment, and the per-customer average. */
  cacTotal: number;
  cac: number | null;
  ltv: number | null;
  ltvCac: number | null;
  lifetimeProfit: number;
  profitPerCustomer: number | null;
  profitPerUnit: number | null;
  arpu: number | null;
  warrantyCost: number;
  serviceCost: number;
  /** Share of customers who have had a replacement shipped. */
  warrantyClaimRate: number | null;
  /** Share of customers who returned a unit. */
  returnRate: number | null;
  /** Share of customers whose lifetime profit is negative. */
  unprofitableRate: number | null;
  /** True when no customer in the segment has traceable acquisition spend. */
  cacUnpriced: boolean;
};

/** Roll a set of customers up into one comparable row.
 *
 *  Segment CAC is the *total* allocated spend over the *total* customers, not
 *  the mean of per-customer CACs — those differ whenever cohorts are uneven,
 *  and the spend-weighted figure is the one that reconciles to the ad bill.
 */
export function rollup(metrics: CustomerMetrics[], key: string, label: string): SegmentMetrics {
  const customers = metrics.length;
  const sum = (f: (m: CustomerMetrics) => number) => metrics.reduce((s, m) => s + f(m), 0);

  const revenue = sum(m => m.revenue);
  const grossRevenue = sum(m => m.grossRevenue);
  const discount = sum(m => m.discount);
  const contributionMargin = sum(m => m.contributionMargin);
  const units = sum(m => m.units);
  const withCac = metrics.filter(m => m.cac != null);
  const cacTotal = withCac.reduce((s, m) => s + (m.cac ?? 0), 0);
  const cac = withCac.length > 0 ? cacTotal / withCac.length : null;
  const ltv = customers > 0 ? contributionMargin / customers : null;
  const lifetimeProfit = contributionMargin - cacTotal;

  return {
    key,
    label,
    customers,
    units,
    revenue,
    grossRevenue,
    discount,
    discountRate: grossRevenue > 0 ? discount / grossRevenue : null,
    variableCosts: sum(m => m.variableCosts),
    contributionMargin,
    contributionMarginPct: revenue > 0 ? contributionMargin / revenue : null,
    cacTotal,
    cac,
    ltv,
    ltvCac: cac != null && cac > 0 && ltv != null ? ltv / cac : null,
    lifetimeProfit,
    profitPerCustomer: customers > 0 ? lifetimeProfit / customers : null,
    profitPerUnit: units > 0 ? lifetimeProfit / units : null,
    arpu: units > 0 ? revenue / units : null,
    warrantyCost: sum(m => m.costs.warranty),
    serviceCost: sum(m => m.costs.support + m.costs.returnHandling),
    warrantyClaimRate: customers > 0
      ? metrics.filter(m => m.costs.warranty > 0).length / customers
      : null,
    returnRate: customers > 0
      ? metrics.filter(m => m.costs.returnHandling > 0).length / customers
      : null,
    unprofitableRate: customers > 0
      ? metrics.filter(m => m.lifetimeProfit < 0).length / customers
      : null,
    cacUnpriced: cacTotal === 0,
  };
}

/** Group customers by any key and roll each group up. Groups come back sorted
 *  by lifetime profit, worst last, so the leaders are at the top of a table. */
export function groupBy(
  metrics: CustomerMetrics[],
  keyOf: (m: CustomerMetrics) => string | null,
  labelOf: (key: string) => string = k => k,
): SegmentMetrics[] {
  const buckets = new Map<string, CustomerMetrics[]>();
  for (const m of metrics) {
    const k = keyOf(m) ?? 'unknown';
    const arr = buckets.get(k);
    if (arr) arr.push(m); else buckets.set(k, [m]);
  }
  return Array.from(buckets.entries())
    .map(([k, arr]) => rollup(arr, k, labelOf(k)))
    .sort((a, b) => b.lifetimeProfit - a.lifetimeProfit);
}

export function byChannel(metrics: CustomerMetrics[]): SegmentMetrics[] {
  return groupBy(metrics, m => m.channel, channelLabel);
}

export function byRegion(metrics: CustomerMetrics[]): SegmentMetrics[] {
  return groupBy(metrics, m => m.regionCode, regionName);
}

export function byCountry(metrics: CustomerMetrics[]): SegmentMetrics[] {
  return groupBy(metrics, m => m.country, c => c === 'unknown' ? 'Unknown' : c);
}

export function byCohort(
  metrics: CustomerMetrics[],
  grain: 'month' | 'quarter' = 'month',
): SegmentMetrics[] {
  const keyOf = (m: CustomerMetrics) =>
    grain === 'month' ? m.cohortMonth : quarterOfMonth(m.cohortMonth);
  return groupBy(metrics, keyOf, k => (k === 'unknown' ? 'Unknown' : k))
    // Cohorts read as a time series, so they sort by date, not by profit.
    .sort((a, b) => a.key.localeCompare(b.key));
}

function quarterOfMonth(month: string | null): string | null {
  if (!month) return null;
  const [y, m] = month.split('-');
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

/** Volume segment: how many machines this customer has bought. The closest
 *  thing to a residential/commercial split the data supports — LILA does not
 *  record customer type, and a multi-unit buyer is the observable proxy. */
export function volumeSegment(m: CustomerMetrics): string {
  if (m.units === 0) return 'no_purchase';
  if (m.units === 1) return 'single_unit';
  if (m.units <= 3) return 'multi_unit';
  return 'fleet';
}

export const VOLUME_LABELS: Record<string, string> = {
  no_purchase: 'No purchase yet',
  single_unit: 'Single unit',
  multi_unit:  '2–3 units',
  fleet:       '4+ units',
};

export function byVolume(metrics: CustomerMetrics[]): SegmentMetrics[] {
  return groupBy(metrics, volumeSegment, k => VOLUME_LABELS[k] ?? k);
}

// ── Portfolio totals ────────────────────────────────────────────────────────

export type PortfolioMetrics = SegmentMetrics & {
  /** Customers whose lifetime profit is below zero. */
  unprofitableCustomers: number;
  breakEvenCustomers: number;
  profitableCustomers: number;
  /** Warranty + service cost over units sold — the reliability headline. */
  warrantyServiceCostPerUnit: number | null;
  /** Customers whose first sale covered their acquisition cost. */
  paybackImmediate: number;
  paybackOutstanding: number;
  recurringRevenue: number;
};

export function portfolio(metrics: CustomerMetrics[]): PortfolioMetrics {
  const base = rollup(metrics, 'all', 'All customers');
  const units = base.units;
  return {
    ...base,
    unprofitableCustomers: metrics.filter(m => m.lifetimeProfit < 0).length,
    breakEvenCustomers:    metrics.filter(m => m.lifetimeProfit === 0).length,
    profitableCustomers:   metrics.filter(m => m.lifetimeProfit > 0).length,
    warrantyServiceCostPerUnit: units > 0
      ? (base.warrantyCost + base.serviceCost) / units
      : null,
    paybackImmediate:   metrics.filter(m => m.payback.status === 'immediate').length,
    paybackOutstanding: metrics.filter(m => m.payback.status === 'not_recovered').length,
    recurringRevenue:   metrics.reduce((s, m) => s + m.recurringRevenue, 0),
  };
}

// ── Distribution ────────────────────────────────────────────────────────────

export type ProfitBucket = { label: string; min: number; max: number; count: number };

/** Buckets for the "who is actually profitable" histogram. The boundaries are
 *  fixed rather than quantile-based so the shape stays comparable as filters
 *  change — a moving axis makes two views impossible to compare. */
export function profitDistribution(metrics: CustomerMetrics[]): ProfitBucket[] {
  const edges: [string, number, number][] = [
    ['< -$2k',        -Infinity, -2000],
    ['-$2k to -$500', -2000,     -500],
    ['-$500 to $0',   -500,      0],
    ['$0 to $250',    0,         250],
    ['$250 to $500',  250,       500],
    ['$500 to $1k',   500,       1000],
    ['> $1k',         1000,      Infinity],
  ];
  return edges.map(([label, min, max]) => ({
    label,
    min,
    max,
    count: metrics.filter(m => m.lifetimeProfit >= min && m.lifetimeProfit < max).length,
  }));
}

/** The nine cost buckets summed across a set of customers. */
export function aggregateCosts(metrics: CustomerMetrics[]): CustomerMetrics['costs'] {
  return metrics.reduce<CustomerMetrics['costs']>((acc, m) => ({
    cogs:           acc.cogs           + m.costs.cogs,
    shipping:       acc.shipping       + m.costs.shipping,
    warranty:       acc.warranty       + m.costs.warranty,
    refunds:        acc.refunds        + m.costs.refunds,
    support:        acc.support        + m.costs.support,
    returnHandling: acc.returnHandling + m.costs.returnHandling,
    paymentFees:    acc.paymentFees    + m.costs.paymentFees,
    commission:     acc.commission     + m.costs.commission,
    installation:   acc.installation   + m.costs.installation,
  }), { cogs: 0, shipping: 0, warranty: 0, refunds: 0, support: 0,
        returnHandling: 0, paymentFees: 0, commission: 0, installation: 0 });
}

export type WaterfallStep = {
  label: string;
  /** Signed: revenue and the totals are positive, each cost is negative. */
  value: number;
  /** A running total (revenue, contribution, profit) rather than a step. */
  isTotal: boolean;
};

/** Revenue → each cost → contribution → CAC → lifetime profit.
 *  Steps carry their own sign so a chart can lay them out directly, and the
 *  totals are flagged so it can baseline them at zero. */
export function waterfall(metrics: CustomerMetrics[], cacTotal: number): WaterfallStep[] {
  const c = aggregateCosts(metrics);
  const revenue = metrics.reduce((s, m) => s + m.revenue, 0);
  const contribution = metrics.reduce((s, m) => s + m.contributionMargin, 0);
  const steps: WaterfallStep[] = [
    { label: 'Revenue',          value: revenue,             isTotal: true },
    { label: 'COGS',             value: -c.cogs,             isTotal: false },
    { label: 'Shipping',         value: -c.shipping,         isTotal: false },
    { label: 'Warranty',         value: -c.warranty,         isTotal: false },
    { label: 'Refunds',          value: -c.refunds,          isTotal: false },
    { label: 'Support',          value: -c.support,          isTotal: false },
    { label: 'Return handling',  value: -c.returnHandling,   isTotal: false },
    { label: 'Payment fees',     value: -c.paymentFees,      isTotal: false },
    { label: 'Commission',       value: -c.commission,       isTotal: false },
    { label: 'Installation',     value: -c.installation,     isTotal: false },
    { label: 'Contribution',     value: contribution,        isTotal: true },
    { label: 'CAC',              value: -cacTotal,           isTotal: false },
    { label: 'Lifetime profit',  value: contribution - cacTotal, isTotal: true },
  ];
  // Zero-value cost steps are noise on a chart — a bucket nobody has priced
  // adds a label and no information.
  return steps.filter(s => s.isTotal || s.value !== 0);
}

// ── Reliability ─────────────────────────────────────────────────────────────

export type ReliabilityMetrics = {
  unitsSold: number;
  customersWithWarrantyClaim: number;
  warrantyClaimRate: number | null;
  replacementsShipped: number;
  replacementRate: number | null;
  warrantyCostPerUnit: number | null;
  serviceCostPerUnit: number | null;
  warrantyPlusServicePerUnit: number | null;
};

export function reliability(rows: CustomerProfitability[]): ReliabilityMetrics {
  const customers = rows.length;
  const unitsSold = rows.reduce((s, r) => s + (r.order_count ?? 0), 0);
  const withClaim = rows.filter(r => (r.replacement_count ?? 0) > 0).length;
  const replacements = rows.reduce((s, r) => s + (r.replacement_count ?? 0), 0);
  const warrantyCost = rows.reduce((s, r) => s + (r.expected_warranty_cost_cad ?? 0), 0);
  const serviceCost = rows.reduce(
    (s, r) => s + (r.support_cost_cad ?? 0) + (r.return_handling_cad ?? 0), 0);

  return {
    unitsSold,
    customersWithWarrantyClaim: withClaim,
    warrantyClaimRate: customers > 0 ? withClaim / customers : null,
    replacementsShipped: replacements,
    replacementRate: unitsSold > 0 ? replacements / unitsSold : null,
    warrantyCostPerUnit: unitsSold > 0 ? warrantyCost / unitsSold : null,
    serviceCostPerUnit:  unitsSold > 0 ? serviceCost / unitsSold : null,
    warrantyPlusServicePerUnit: unitsSold > 0 ? (warrantyCost + serviceCost) / unitsSold : null,
  };
}

// ── Metrics we cannot compute ───────────────────────────────────────────────

/** Metrics the spec asks for that no table in this database can answer.
 *  Surfaced in the UI as an explicit "unavailable" list, because a dashboard
 *  that silently omits a metric reads as though it were measured and fine. */
export const UNAVAILABLE_METRICS: { metric: string; reason: string }[] = [
  { metric: 'Utilization rate, cycles, waste processed',
    reason: 'Machine telemetry lives in the Lovely dashboard, not in this database. No usage rows to aggregate.' },
  { metric: 'Active-usage rate (30/90/180/365-day)',
    reason: 'Same: needs per-unit telemetry. The Lovely Activity tab tracks machine presence, but it is not joined to financial records.' },
  { metric: 'Subscription and service-plan retention',
    reason: 'LILA sells no subscription or service plan. There is nothing to retain.' },
  { metric: 'Churn rate',
    reason: 'A one-time hardware purchase has no renewal event to miss. Return and refund rates stand in for it.' },
  { metric: 'Recurring revenue (MRR/ARR)',
    reason: 'No recurring revenue product exists yet. Held at $0 rather than estimated.' },
  { metric: 'Residential vs commercial split',
    reason: 'Customer type is not recorded. Units purchased is used as the closest observable proxy.' },
  { metric: 'Per-campaign and per-rep CAC',
    reason: 'Spend is synced at campaign level for Meta only; other channels have no spend feed, and no order carries a sales rep.' },
];
