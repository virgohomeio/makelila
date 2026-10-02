import type { CustomerMetrics, SegmentMetrics } from './profitability';
import { rollup, aggregateCosts } from './profitability';
import {
  landedCostPerUnit, costPerSellableUnit,
  type LandedCost, type UnitCensus,
} from './batchLandedCost';

/**
 *  Batch profitability — which LILA Pro production batch made money, and where.
 *
 *  ## Why this file exists
 *
 *  `customer_profitability` aggregates to the *customer*. A batch is a
 *  property of the *unit*. The two grains only coincide because almost every
 *  LILA customer owns exactly one machine — 149 of the 158 attributable units
 *  today — so a customer's economics can be pushed down onto their units with
 *  very little violence.
 *
 *  That is exactly what this module does, and the reason it works this way
 *  rather than re-deriving margin from `orders` is consistency: a batch total
 *  here sums the *same* `CustomerMetrics` the Overview, Geography and Cohort
 *  views are built from. Batch revenue therefore reconciles to portfolio
 *  revenue by construction, and a change to the cost model lands on every view
 *  at once instead of drifting between two parallel margin formulas.
 *
 *  ## The allocation rule
 *
 *  A customer's revenue and every cost bucket are split **equally across their
 *  shipped units**. One unit → the whole row. Two units → half each.
 *
 *  Equal split is not the only defensible rule (a revenue-weighted split would
 *  be more precise for mixed baskets), but it is the only one the data
 *  supports: order line items do not reliably say which serial carried which
 *  price, and only 3 customers in the whole book own units from more than one
 *  batch. `mixedBatchCustomers` counts them so the UI can name the exposure
 *  rather than hide it.
 */

/** Chronological, oldest first — batches read as a product timeline, not a
 *  leaderboard, so this is the order the table and the matrix use. */
export const BATCH_ORDER = ['P50', 'P150', 'P50N', 'P100', 'P100X'] as const;

export type BatchId = typeof BATCH_ORDER[number];

/** Landed cost and era, for the batch table's context columns. Sourced from
 *  public.batches; kept here only as display labels. */
export const BATCH_LABELS: Record<string, string> = {
  P50:   'P50',
  P150:  'P150',
  P50N:  'P50N',
  P100:  'P100',
  P100X: 'P100X',
};

/** A shipped unit, resolved to the customer whose economics it carries. */
export type UnitBatchLink = {
  serial: string;
  batch: string;
  /** null when the unit could not be traced to a customer — counted as
   *  unattributed rather than dropped silently. */
  customerId: string | null;
  shippedAt: string | null;
};

/** A batch that exists in `batches` but has shipped nothing yet (P100X).
 *  It has no margin, and must not be rendered as if it had a margin of zero. */
export type FutureBatch = {
  key: string;
  label: string;
  unitCount: number;
  /** null while the factory invoice has not landed. */
  unitCostUsd: number | null;
  expectedArrival: string | null;
  status: string;
};

export type BatchCoverage = {
  /** Shipped units seen in `units`, per batch. */
  shipped: number;
  /** Of those, how many carry a customer whose metrics we could find. */
  attributed: number;
  /** Units with no traceable customer — their margin is in nobody's batch. */
  unattributed: number;
};

/** How a batch's COGS was arrived at. `schedule` is a modelled placeholder —
 *  for the pre-P100 batches it is a flat legacy figure that does not track the
 *  batch's invoiced landed cost, so a margin built on it is not a verdict on
 *  the hardware. */
export type CogsBasisCount = { actual: number; modelled: number };

export type BatchMetrics = SegmentMetrics & {
  /** The eleven cost buckets, summed over the batch. `SegmentMetrics` carries
   *  only the warranty and service totals, but a batch comparison lives or
   *  dies on COGS and freight per unit. */
  costs: CustomerMetrics['costs'];
  coverage: BatchCoverage;
  /** Customers in this batch who also own a unit from a different batch, and
   *  whose costs are therefore split across batches by the equal-split rule. */
  mixedBatchCustomers: number;
  /** First and last ship date — the batch's selling era. */
  firstShipped: string | null;
  lastShipped: string | null;
  /** Country split of the batch's units — context for comparing batches, not a
   *  basis for a regional margin. See MarketMix. */
  marketMix: MarketMix;
  /** Sale orders behind this batch's COGS, split by how the cost was derived. */
  cogsBasis: CogsBasisCount;
  /** Share of those orders on the modelled schedule, or null when unknown. */
  cogsModelledPct: number | null;
  /** What one unit of this batch cost to put on a shelf in Toronto, normalised
   *  across incoterms. Null when the batch cannot be costed at all.
   *
   *  This is deliberately *not* folded into `costs.cogs`. The margin columns
   *  keep summing the same `customer_profitability` rows as every other view,
   *  so batch revenue and profit still reconcile to the portfolio by
   *  construction. Landed cost sits beside them as the procurement truth the
   *  booked COGS should eventually be restated onto. */
  landed: LandedCost | null;
  /** Unit dispositions, and the sellable band derived from them. Null when no
   *  census was supplied. */
  census: UnitCensus | null;
  /** Landed cost spread over the units that survived production, as a band.
   *  This is the figure that actually separates the batches. */
  costPerSellable: { low: number; high: number } | null;
};

// ── Allocation ──────────────────────────────────────────────────────────────

/** Scale one customer's metrics down to the share carried by `unitsInBatch`
 *  of their `totalUnits` machines.
 *
 *  Everything additive scales. Everything that is already a *rate* (CM %,
 *  LTV:CAC, discount rate) is left alone — a half-share of a customer has the
 *  same margin percentage as the whole, and rescaling it would be wrong.
 *  `units` becomes the count actually in this batch so per-unit figures divide
 *  by the right denominator.
 */
export function scaleMetrics(
  m: CustomerMetrics,
  unitsInBatch: number,
  totalUnits: number,
): CustomerMetrics {
  const w = totalUnits > 0 ? unitsInBatch / totalUnits : 0;
  return {
    ...m,
    revenue:          m.revenue * w,
    grossRevenue:     m.grossRevenue * w,
    discount:         m.discount * w,
    initialRevenue:   m.initialRevenue * w,
    upsellRevenue:    m.upsellRevenue * w,
    recurringRevenue: m.recurringRevenue * w,
    costs: {
      cogs:           m.costs.cogs * w,
      shipping:       m.costs.shipping * w,
      warranty:       m.costs.warranty * w,
      refunds:        m.costs.refunds * w,
      support:        m.costs.support * w,
      returnHandling: m.costs.returnHandling * w,
      paymentFees:    m.costs.paymentFees * w,
      commission:     m.costs.commission * w,
      installation:   m.costs.installation * w,
      consumables:    m.costs.consumables * w,
      fulfilment:     m.costs.fulfilment * w,
    },
    variableCosts:     m.variableCosts * w,
    contributionMargin: m.contributionMargin * w,
    cac:               m.cac == null ? null : m.cac * w,
    realizedLtv:       m.realizedLtv * w,
    projectedLtv:      m.projectedLtv * w,
    lifetimeProfit:    m.lifetimeProfit * w,
    units:             unitsInBatch,
  };
}

/** Group the unit links by batch, carrying each customer's scaled share.
 *  Units whose customer is absent from `metrics` are counted as unattributed
 *  and contribute nothing to margin — never a zero-margin row, which would
 *  drag a batch's average toward break-even for free. */
function partition(
  metrics: Map<string, CustomerMetrics>,
  links: UnitBatchLink[],
): {
  byBatchKey: Map<string, CustomerMetrics[]>;
  coverage: Map<string, BatchCoverage>;
  mixed: Map<string, number>;
  era: Map<string, { first: string | null; last: string | null }>;
  customerIds: Map<string, string[]>;
} {
  // How many shipped units each customer owns, across all batches — the
  // denominator of the equal split.
  const unitsPerCustomer = new Map<string, number>();
  const batchesPerCustomer = new Map<string, Set<string>>();
  for (const l of links) {
    if (!l.customerId) continue;
    unitsPerCustomer.set(l.customerId, (unitsPerCustomer.get(l.customerId) ?? 0) + 1);
    const set = batchesPerCustomer.get(l.customerId) ?? new Set<string>();
    set.add(l.batch);
    batchesPerCustomer.set(l.customerId, set);
  }

  // Units this customer owns *within* each batch, so a customer with two P100s
  // contributes one row weighted 2/2 rather than two rows of 1/2 — otherwise
  // rollup would count them as two customers.
  const perBatchCustomer = new Map<string, Map<string, number>>();
  const coverage = new Map<string, BatchCoverage>();
  const era = new Map<string, { first: string | null; last: string | null }>();

  for (const l of links) {
    const cov = coverage.get(l.batch) ?? { shipped: 0, attributed: 0, unattributed: 0 };
    cov.shipped += 1;

    const e = era.get(l.batch) ?? { first: null, last: null };
    if (l.shippedAt) {
      if (!e.first || l.shippedAt < e.first) e.first = l.shippedAt;
      if (!e.last || l.shippedAt > e.last) e.last = l.shippedAt;
    }
    era.set(l.batch, e);

    if (l.customerId && metrics.has(l.customerId)) {
      cov.attributed += 1;
      const inner = perBatchCustomer.get(l.batch) ?? new Map<string, number>();
      inner.set(l.customerId, (inner.get(l.customerId) ?? 0) + 1);
      perBatchCustomer.set(l.batch, inner);
    } else {
      cov.unattributed += 1;
    }
    coverage.set(l.batch, cov);
  }

  const byBatchKey = new Map<string, CustomerMetrics[]>();
  const mixed = new Map<string, number>();
  for (const [batch, inner] of perBatchCustomer) {
    const arr: CustomerMetrics[] = [];
    let mixedCount = 0;
    for (const [customerId, n] of inner) {
      const m = metrics.get(customerId)!;
      arr.push(scaleMetrics(m, n, unitsPerCustomer.get(customerId) ?? n));
      if ((batchesPerCustomer.get(customerId)?.size ?? 1) > 1) mixedCount += 1;
    }
    byBatchKey.set(batch, arr);
    mixed.set(batch, mixedCount);
  }

  const customerIds = new Map<string, string[]>();
  for (const [batch, inner] of perBatchCustomer) customerIds.set(batch, Array.from(inner.keys()));

  return { byBatchKey, coverage, mixed, era, customerIds };
}

/** Units per country for one batch's customers, largest market first. */
function marketMixOf(arr: CustomerMetrics[]): MarketMix {
  const counts = new Map<string, number>();
  for (const m of arr) {
    const c = m.country ?? 'unknown';
    counts.set(c, (counts.get(c) ?? 0) + m.units);
  }
  return Array.from(counts.entries())
    .map(([country, units]) => ({ country, units }))
    .sort((a, b) => b.units - a.units || a.country.localeCompare(b.country));
}

/** Sum the COGS basis counts of every customer behind a batch. */
function cogsBasisFor(
  ids: string[] | undefined,
  basisOf?: (customerId: string) => CogsBasisCount | undefined,
): { cogsBasis: CogsBasisCount; cogsModelledPct: number | null } {
  const cogsBasis: CogsBasisCount = { actual: 0, modelled: 0 };
  if (!ids || !basisOf) return { cogsBasis, cogsModelledPct: null };
  for (const id of ids) {
    const b = basisOf(id);
    if (!b) continue;
    cogsBasis.actual += b.actual;
    cogsBasis.modelled += b.modelled;
  }
  const total = cogsBasis.actual + cogsBasis.modelled;
  return { cogsBasis, cogsModelledPct: total > 0 ? cogsBasis.modelled / total : null };
}

/** Batches whose cost is mostly or entirely a modelled placeholder rather than
 *  an invoice. Their margin ranking is an artifact of the cost schedule as much
 *  as of the batch, and the UI has to say so. */
export function modelledCostBatches(
  rows: BatchMetrics[],
  threshold = 0.9,
): BatchMetrics[] {
  return rows.filter(r => r.cogsModelledPct != null && r.cogsModelledPct >= threshold);
}

/** Roll every batch up into one comparable row, oldest batch first. */
export function byBatch(
  metrics: Map<string, CustomerMetrics>,
  links: UnitBatchLink[],
  /** Per-customer COGS basis counts, from `customer_profitability`. Optional so
   *  the calc still works for callers that have no basis data. */
  basisOf?: (customerId: string) => CogsBasisCount | undefined,
  /** Landed-cost inputs. Optional: without them the batch rows keep every
   *  margin column and simply carry no landed cost, rather than failing. */
  landedInput?: {
    census: Map<string, UnitCensus>;
    facts: Map<string, { unitCount: number; unitCostUsd: number | null }>;
  },
): BatchMetrics[] {
  const { byBatchKey, coverage, mixed, era, customerIds } = partition(metrics, links);

  // Iterate coverage, not byBatchKey: a batch whose units are *all*
  // unattributed has no metrics to roll up, but it still shipped and still
  // belongs in the table — dropping it would silently shrink the unit count.
  const rows: BatchMetrics[] = [];
  for (const batch of coverage.keys()) {
    const arr = byBatchKey.get(batch) ?? [];
    const e = era.get(batch) ?? { first: null, last: null };
    rows.push({
      ...rollup(arr, batch, BATCH_LABELS[batch] ?? batch),
      costs: aggregateCosts(arr),
      coverage: coverage.get(batch) ?? { shipped: 0, attributed: 0, unattributed: 0 },
      marketMix: marketMixOf(arr),
      ...cogsBasisFor(customerIds.get(batch), basisOf),
      ...landedFor(batch, landedInput),
      mixedBatchCustomers: mixed.get(batch) ?? 0,
      firstShipped: e.first,
      lastShipped: e.last,
    });
  }
  return rows.sort(byBatchChronology);
}

/** Normalise one batch onto landed cost, and spread it over the units that
 *  survived. The census is the authority on batch size — `units` rows are what
 *  actually exist, whereas `batches.unit_count` is what was ordered, and for
 *  P50N those disagree (the invoice covered 40 machines plus 40 spare lids). */
function landedFor(
  batch: string,
  input?: {
    census: Map<string, UnitCensus>;
    facts: Map<string, { unitCount: number; unitCostUsd: number | null }>;
  },
): Pick<BatchMetrics, 'landed' | 'census' | 'costPerSellable'> {
  if (!input) return { landed: null, census: null, costPerSellable: null };

  const census = input.census.get(batch) ?? null;
  const facts = input.facts.get(batch);
  const landed = landedCostPerUnit({
    batchId: batch,
    invoiceUnitCostUsd: facts?.unitCostUsd ?? null,
    // Clearance is spread over the entry, which is the batch as invoiced.
    unitCount: facts?.unitCount ?? census?.total ?? 0,
  });

  return {
    landed,
    census,
    costPerSellable:
      landed && census ? costPerSellableUnit(landed.landedUsd, census) : null,
  };
}

/** Batches sort by their position in the production timeline; anything not in
 *  BATCH_ORDER (a batch added after this file was written) sorts after the
 *  known ones, alphabetically, rather than being dropped. */
export function byBatchChronology(
  a: { key: string }, b: { key: string },
): number {
  const ia = BATCH_ORDER.indexOf(a.key as BatchId);
  const ib = BATCH_ORDER.indexOf(b.key as BatchId);
  if (ia === -1 && ib === -1) return a.key.localeCompare(b.key);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
}

// ── Market mix ──────────────────────────────────────────────────────────────

/**
 *  Where a batch's units went, as a country split.
 *
 *  This is deliberately NOT a profitability breakdown. Batch and geography are
 *  the same variable in this dataset — P50 and P150 sold into Canada only,
 *  P50N almost entirely into the US, and only P100 sold into both — so a
 *  per-region margin for a batch reports the border as though it were the
 *  machine. The mix is carried as plain context instead: enough to see that
 *  two batches sold into different markets when comparing them, without
 *  inviting a regional verdict the data cannot support.
 */
export type MarketMix = { country: string; units: number }[];

/** The share of a batch's units in its single largest market, or null when the
 *  country is unknown for all of them. */
export function dominantMarketShare(mix: MarketMix): { country: string; share: number } | null {
  const known = mix.filter(m => m.country !== 'unknown');
  const total = known.reduce((s, m) => s + m.units, 0);
  if (total === 0) return null;
  return { country: known[0].country, share: known[0].units / total };
}

/**
 *  Batches that sold into essentially one country.
 *
 *  Their margin cannot be compared like-for-like against a batch that sold
 *  across the border, because freight, duty and tax ride along with the
 *  market. The batch table names them so the ranking is read with that in
 *  mind. `minUnits` keeps a two-unit batch from being described as a market.
 */
export function singleMarketBatches(
  rows: BatchMetrics[],
  minUnits = 5,
  threshold = 0.9,
): { batch: string; label: string; country: string; units: number }[] {
  const out: { batch: string; label: string; country: string; units: number }[] = [];
  for (const r of rows) {
    const known = r.marketMix.filter(m => m.country !== 'unknown');
    const total = known.reduce((s, m) => s + m.units, 0);
    if (total < minUnits) continue;
    const top = known[0];
    if (top.units / total >= threshold) {
      out.push({ batch: r.key, label: r.label, country: top.country, units: top.units });
    }
  }
  return out.sort((a, b) => byBatchChronology({ key: a.batch }, { key: b.batch }));
}

/** Portfolio-wide attribution coverage, for the caveat line above the table. */
export function attributionCoverage(rows: BatchMetrics[]): BatchCoverage {
  return rows.reduce<BatchCoverage>((acc, r) => ({
    shipped:      acc.shipped + r.coverage.shipped,
    attributed:   acc.attributed + r.coverage.attributed,
    unattributed: acc.unattributed + r.coverage.unattributed,
  }), { shipped: 0, attributed: 0, unattributed: 0 });
}
