import type { CustomerMetrics, SegmentMetrics } from './profitability';
import { rollup, groupBy, aggregateCosts } from './profitability';
import { regionName } from './regions';

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
  /** Sale orders behind this batch's COGS, split by how the cost was derived. */
  cogsBasis: CogsBasisCount;
  /** Share of those orders on the modelled schedule, or null when unknown. */
  cogsModelledPct: number | null;
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
      ...cogsBasisFor(customerIds.get(batch), basisOf),
      mixedBatchCustomers: mixed.get(batch) ?? 0,
      firstShipped: e.first,
      lastShipped: e.last,
    });
  }
  return rows.sort(byBatchChronology);
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

// ── Batch × region ──────────────────────────────────────────────────────────

export type BatchRegionCell = SegmentMetrics & {
  batch: string;
  regionCode: string;
};

export type BatchRegionMatrix = {
  batches: string[];
  /** Region codes, ordered by total units across all batches, busiest first. */
  regions: string[];
  /** Keyed `${batch}|${regionCode}`. A missing key means the batch never
   *  shipped to that region — which is NOT the same as losing money there. */
  cells: Map<string, BatchRegionCell>;
  /** Units per region across every batch, for the row headers. */
  regionUnits: Map<string, number>;
};

/**
 *  Cross batch with province/state.
 *
 *  Region comes from `CustomerMetrics.regionCode`, the same field the map and
 *  the region table use — so a cell here and a region there are the same
 *  population, and the two views cannot disagree.
 */
export function byBatchRegion(
  metrics: Map<string, CustomerMetrics>,
  links: UnitBatchLink[],
): BatchRegionMatrix {
  const { byBatchKey } = partition(metrics, links);

  const cells = new Map<string, BatchRegionCell>();
  const regionUnits = new Map<string, number>();
  const batches: string[] = [];

  for (const [batch, arr] of byBatchKey) {
    batches.push(batch);
    const perRegion = groupBy(arr, m => m.regionCode, regionName);
    for (const seg of perRegion) {
      if (seg.key === 'unknown') continue;
      cells.set(`${batch}|${seg.key}`, { ...seg, batch, regionCode: seg.key });
      regionUnits.set(seg.key, (regionUnits.get(seg.key) ?? 0) + seg.units);
    }
  }

  const regions = Array.from(regionUnits.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code);

  return {
    batches: batches.sort((a, b) => byBatchChronology({ key: a }, { key: b })),
    regions,
    cells,
    regionUnits,
  };
}

/**
 *  Regions a batch never shipped to.
 *
 *  This is the guard-rail on the whole comparison. P150 and P50 sold into
 *  Canada only; P50N sold almost entirely into the US. Read naively, the
 *  matrix invites "P150 loses money in the US" — but no P150 ever went to the
 *  US, so the cell is empty, not bad. Anything reading the matrix has to be
 *  able to tell those two apart, so absence is returned explicitly rather than
 *  left as a hole for the caller to interpret.
 */
export function batchRegionGaps(
  matrix: BatchRegionMatrix,
): Map<string, string[]> {
  const gaps = new Map<string, string[]>();
  for (const batch of matrix.batches) {
    const missing = matrix.regions.filter(r => !matrix.cells.has(`${batch}|${r}`));
    gaps.set(batch, missing);
  }
  return gaps;
}

/** Country reach per batch, used to warn that a batch/region comparison is
 *  confounded when a batch only ever sold into one country. */
export function batchCountryReach(
  metrics: Map<string, CustomerMetrics>,
  links: UnitBatchLink[],
): Map<string, { country: string; units: number }[]> {
  const { byBatchKey } = partition(metrics, links);
  const out = new Map<string, { country: string; units: number }[]>();
  for (const [batch, arr] of byBatchKey) {
    const counts = new Map<string, number>();
    for (const m of arr) {
      const c = m.country ?? 'unknown';
      counts.set(c, (counts.get(c) ?? 0) + m.units);
    }
    out.set(batch, Array.from(counts.entries())
      .map(([country, units]) => ({ country, units }))
      .sort((a, b) => b.units - a.units));
  }
  return out;
}

/**
 *  Batches whose geography is too narrow to compare against the others.
 *
 *  A batch that sold into a single country cannot be ranked against one that
 *  sold into two — the difference could be the batch, or it could be the
 *  freight, duty and tax of the country it happened to sell into. Returns the
 *  batch keys that are single-country, with the country, so the UI can say so
 *  in words.
 */
export function confoundedBatches(
  reach: Map<string, { country: string; units: number }[]>,
  minUnits = 5,
): { batch: string; country: string; units: number }[] {
  const out: { batch: string; country: string; units: number }[] = [];
  for (const [batch, countries] of reach) {
    const known = countries.filter(c => c.country !== 'unknown');
    const total = known.reduce((s, c) => s + c.units, 0);
    if (total < minUnits) continue;
    // "Single country" in practice, not just in principle: P50N's 29 US units
    // and 1 Canadian one make it a US batch for comparison purposes.
    const top = known[0];
    if (top.units / total >= 0.9) out.push({ batch, country: top.country, units: top.units });
  }
  return out.sort((a, b) => byBatchChronology({ key: a.batch }, { key: b.batch }));
}

/** The regions where a batch made and lost the most money per unit, among
 *  regions with at least `minUnits` units — small cells are noise, and a
 *  one-unit region topping the list would be a lie of presentation. */
export function batchRegionExtremes(
  matrix: BatchRegionMatrix,
  batch: string,
  minUnits = 3,
): { best: BatchRegionCell | null; worst: BatchRegionCell | null; ranked: BatchRegionCell[] } {
  const ranked = matrix.regions
    .map(r => matrix.cells.get(`${batch}|${r}`))
    .filter((c): c is BatchRegionCell => c != null && c.units >= minUnits)
    .sort((a, b) => (b.profitPerUnit ?? 0) - (a.profitPerUnit ?? 0));

  return {
    best: ranked.length > 0 ? ranked[0] : null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    ranked,
  };
}

/** Portfolio-wide attribution coverage, for the caveat line above the table. */
export function attributionCoverage(rows: BatchMetrics[]): BatchCoverage {
  return rows.reduce<BatchCoverage>((acc, r) => ({
    shipped:      acc.shipped + r.coverage.shipped,
    attributed:   acc.attributed + r.coverage.attributed,
    unattributed: acc.unattributed + r.coverage.unattributed,
  }), { shipped: 0, attributed: 0, unattributed: 0 });
}
