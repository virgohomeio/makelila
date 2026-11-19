/**
 *  Batch landed cost — putting every production run on one comparable basis.
 *
 *  ## Why the invoice price is not comparable
 *
 *  `batches.unit_cost_usd` is what the factory billed, and across five batches
 *  it is billed on two different incoterms:
 *
 *    - **P50, P150 — FOB Ningbo.** Ocean freight, brokerage and drayage to
 *      Toronto are all *excluded*. The invoice understates what the unit cost
 *      to have on a shelf in Markham.
 *    - **P50N, P100, P100X — CNF Toronto.** Freight to Toronto is *inside* the
 *      price. Customs clearance still is not — CNF stops at the port, and the
 *      buyer files the entry (Elopa, for P100).
 *
 *  Comparing $900 FOB against $314 CNF flatters the newer batches on freight
 *  and flatters the older ones on nothing. This module normalises both onto
 *  **landed cost per unit in Toronto**, which is the only basis on which
 *  "what did a P150 cost vs a P100" has an answer.
 *
 *  ## Estimated, and labelled as such
 *
 *  No inbound freight or customs invoice has been captured in the database,
 *  so the freight and clearance layers here are **estimates**, carried per
 *  batch in `LANDED_COST_ESTIMATES` with the derivation written down. Every
 *  figure this module returns is stamped with a `basis` so the UI can say
 *  "estimated" rather than presenting a guess as an invoice. The house rule
 *  that an unknown cost is labelled rather than silently zeroed applies here
 *  too: a batch we cannot cost returns `null`, never `0`.
 *
 *  Replace an estimate the moment an actual lands — the Elopa entry summary
 *  settles duty and brokerage, and MBV's freight invoices settle P50/P150.
 *  Each is a one-line change here.
 *
 *  ## The second normalisation: yield
 *
 *  Landed cost per unit *bought* still is not the cost of a unit you can sell.
 *  P150 bought 150 and can currently account for 43 good machines; P100 bought
 *  100 and scrapped 1. `costPerSellableUnit` spreads the whole batch's cost
 *  over the units that survived, which is where the real gap between the
 *  batches shows up — it is mostly yield, not procurement.
 */

/** USD → CAD. Mirrors `public.fx_rates` (1 CAD = 0.72 USD, per Huayi
 *  2026-08-12); kept as a constant so batch costing is reproducible rather
 *  than moving under the table when the rate is refreshed. */
export const USD_CAD = 1.388889;

/** Customs brokerage + terminal + drayage for one import entry, USD.
 *  ~$400 CAD, the going rate for a single-container entry. Charged per *entry*
 *  and therefore spread across the batch — which is why small batches carry
 *  more of it per unit. */
export const CLEARANCE_ENTRY_USD = 288;

/** Duty actually charged, as a fraction of invoice value.
 *
 *  Zero on the assumption the machine classifies to HS 8479.89.90 — machines
 *  having individual functions — which is MFN duty-free into Canada from
 *  China. GST is deliberately excluded: it is a recoverable input tax credit,
 *  not a cost of goods. */
export const DUTY_RATE = 0;

/** What duty *would* cost if the unit classified as an appliance instead.
 *  Not charged; surfaced so the exposure is visible rather than forgotten.
 *  The Elopa entry summary settles this one way or the other. */
export const DUTY_RATE_IF_APPLIANCE = 0.07;

export type CostBasis =
  /** Every layer came from an invoice. */
  | 'invoiced'
  /** At least one layer is a modelled estimate. */
  | 'estimated';

/** The inbound-logistics assumptions for one batch. */
export type LandedCostEstimate = {
  /** Inbound freight to Toronto, USD per unit. Zero when the incoterm already
   *  includes it — that is a fact about the incoterm, not a missing value. */
  freightPerUnitUsd: number;
  /** The incoterm the factory invoiced on, which is what decides whether
   *  freight has to be added. */
  incoterm: string;
  /** Unit price to assume when the factory has not invoiced yet. Null once an
   *  invoice is the only acceptable source. */
  assumedUnitCostUsd: number | null;
  /** How the freight figure was arrived at, so a reviewer can argue with it. */
  note: string;
};

/**
 *  Per-batch estimates.
 *
 *  Freight derivation rests on one observation: P100 moved as a single
 *  container (MSDU5858060) carrying 100 units, so a 40HC holds ~100 machines.
 *  Ningbo → Toronto door ran ~$5,500 USD per 40HC over 2025–26.
 */
export const LANDED_COST_ESTIMATES: Record<string, LandedCostEstimate> = {
  P50: {
    freightPerUnitUsd: 80,
    incoterm: 'FOB Ningbo',
    assumedUnitCostUsd: null,
    note: '50 units is half a container, so it moves LCL at roughly $4,000 '
      + 'Ningbo→Toronto — $80/unit. Small batches carry the worst freight rate '
      + 'per unit, which is why this exceeds P150 despite a third the volume.',
  },
  P150: {
    freightPerUnitUsd: 58,
    incoterm: 'FOB Ningbo',
    assumedUnitCostUsd: null,
    note: '145 units by sea at ~1.45 containers x $5,500 = $8,000, plus 5 units '
      + 'air-freighted 2025-07-19 at ~$140 each ($700). $8,700 / 150 = $58/unit.',
  },
  P50N: {
    freightPerUnitUsd: 0,
    incoterm: 'CNF Toronto',
    assumedUnitCostUsd: null,
    note: 'CNF Toronto — ocean freight is already inside the $314 unit price. '
      + 'Note the invoice total ($13,300) also covers 40 replacement top lids '
      + 'for P150 at $18.50 each, so it must not be divided by the unit count.',
  },
  P100: {
    freightPerUnitUsd: 0,
    incoterm: 'CNF Toronto',
    assumedUnitCostUsd: null,
    note: 'CNF Toronto — freight is inside the $314 unit price. One container, '
      + 'MSDU5858060, cleared by Elopa.',
  },
  P100X: {
    freightPerUnitUsd: 0,
    incoterm: 'CNF Toronto',
    assumedUnitCostUsd: 314,
    note: 'Not invoiced yet. Priced at P100 parity — same manufacturer (LC), '
      + 'same 100 units, same incoterm. The "8 parts removed vs P100" change '
      + 'should push it below $314, but nothing quantifies by how much, so '
      + 'parity is the conservative assumption.',
  },
};

/** One batch's cost, layer by layer, in the currency it was incurred. */
export type LandedCost = {
  /** Factory price per unit. */
  invoiceUsd: number;
  /** True when `invoiceUsd` is an assumption rather than a real invoice. */
  invoiceAssumed: boolean;
  /** Inbound freight to Toronto, per unit. */
  freightUsd: number;
  /** Duty actually charged, per unit. */
  dutyUsd: number;
  /** Duty that would apply under the appliance classification — not charged. */
  dutyExposureUsd: number;
  /** Brokerage + drayage, per unit. */
  clearanceUsd: number;
  /** Everything above, per unit. */
  landedUsd: number;
  landedCad: number;
  basis: CostBasis;
  /** The incoterm this was normalised from, for the UI tooltip. */
  incoterm: string | null;
  note: string | null;
};

/**
 *  Landed cost for one unit of a batch.
 *
 *  Returns `null` when the batch cannot be costed at all — no invoice and no
 *  assumption. A batch we know nothing about must read as unpriced, not as
 *  free.
 */
export function landedCostPerUnit(input: {
  batchId: string;
  invoiceUnitCostUsd: number | null;
  unitCount: number;
}): LandedCost | null {
  const est = LANDED_COST_ESTIMATES[input.batchId];

  const invoiced = input.invoiceUnitCostUsd;
  const assumed = est?.assumedUnitCostUsd ?? null;
  const invoiceUsd = invoiced ?? assumed;
  if (invoiceUsd == null) return null;

  const invoiceAssumed = invoiced == null;
  const freightUsd = est?.freightPerUnitUsd ?? 0;
  // Clearance is a per-entry charge; with no units to spread it over there is
  // nothing to allocate, and dividing would be a division by zero.
  const clearanceUsd = input.unitCount > 0 && est ? CLEARANCE_ENTRY_USD / input.unitCount : 0;
  const dutyUsd = invoiceUsd * DUTY_RATE;

  // Only the modelled layers make this an estimate. A batch with no estimate
  // row is costed off its invoice alone and is honestly labelled 'invoiced'.
  const basis: CostBasis =
    invoiceAssumed || freightUsd > 0 || clearanceUsd > 0 ? 'estimated' : 'invoiced';

  return {
    invoiceUsd,
    invoiceAssumed,
    freightUsd,
    dutyUsd,
    dutyExposureUsd: invoiceUsd * DUTY_RATE_IF_APPLIANCE,
    clearanceUsd,
    landedUsd: invoiceUsd + freightUsd + dutyUsd + clearanceUsd,
    landedCad: (invoiceUsd + freightUsd + dutyUsd + clearanceUsd) * USD_CAD,
    basis,
    incoterm: est?.incoterm ?? null,
    note: est?.note ?? null,
  };
}

// ── Yield ───────────────────────────────────────────────────────────────────

/** Unit dispositions for one batch, from `units.status`. */
export type UnitCensus = {
  total: number;
  scrap: number;
  lost: number;
  rework: number;
  shipped: number;
  ready: number;
};

/**
 *  How many units of a batch are sellable, as a band.
 *
 *  The band exists because two statuses are genuinely ambiguous:
 *
 *    - **`rework`** may or may not come back as sellable stock. P150 holds 72
 *      of these, which is why its band is so wide.
 *    - **`lost`** may be physically gone or may be a data artifact — the June
 *      2026 backfill left unit records mis-linked, and 34 P150 + 16 P50 units
 *      sit in this status.
 *
 *  `low` writes both off. `high` assumes rework is recovered and `lost` units
 *  are found. Reporting one number would hide a 3x spread on P150.
 */
export function sellableBand(c: UnitCensus): { low: number; high: number } {
  const clamp = (n: number) => Math.max(0, Math.min(c.total, n));
  return {
    low: clamp(c.total - c.scrap - c.lost - c.rework),
    high: clamp(c.total - c.scrap),
  };
}

/**
 *  The whole batch's landed cost spread over the units that survived it.
 *
 *  Scrap is not free: a batch that bought 150 and can sell 43 paid for 150.
 *  Null when nothing survived — an infinite cost per unit is not a number the
 *  UI can render, and zero would be a lie.
 *
 *  Note the inversion: the *high* sellable count produces the *low* cost.
 */
export function costPerSellableUnit(
  landedUsd: number,
  c: UnitCensus,
): { low: number; high: number } | null {
  if (c.total <= 0) return null;
  const band = sellableBand(c);
  if (band.low <= 0 && band.high <= 0) return null;

  const spread = (sellable: number) =>
    sellable > 0 ? (landedUsd * c.total) / sellable : null;

  const low = spread(band.high);
  const high = spread(band.low);
  // A batch whose low bound is zero still has a meaningful best case; fall
  // back to it rather than dropping the batch entirely.
  if (low == null) return null;
  return { low, high: high ?? low };
}

/** Bucket raw `units` rows into a per-batch census. Statuses outside the four
 *  that matter for yield (`team-test`, `ca-test`, `cn-test`, `in-production`)
 *  count toward `total` only — they are neither waste nor sold. */
export function batchCensus(
  rows: { batch: string | null; status: string | null }[],
): Map<string, UnitCensus> {
  const out = new Map<string, UnitCensus>();
  for (const r of rows) {
    if (!r.batch) continue;
    const c = out.get(r.batch)
      ?? { total: 0, scrap: 0, lost: 0, rework: 0, shipped: 0, ready: 0 };
    c.total += 1;
    switch (r.status) {
      case 'scrap':   c.scrap += 1; break;
      case 'lost':    c.lost += 1; break;
      case 'rework':  c.rework += 1; break;
      case 'shipped': c.shipped += 1; break;
      case 'ready':   c.ready += 1; break;
      default: break;
    }
    out.set(r.batch, c);
  }
  return out;
}
