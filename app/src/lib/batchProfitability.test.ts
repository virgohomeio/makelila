import { describe, it, expect } from 'vitest';
import type { CustomerMetrics } from './profitability';
import {
  BATCH_ORDER, byBatch, byBatchRegion, byBatchChronology, scaleMetrics,
  batchRegionGaps, batchCountryReach, confoundedBatches, batchRegionExtremes,
  attributionCoverage, type UnitBatchLink,
} from './batchProfitability';

/** A customer with round numbers, so allocation arithmetic is readable. */
function metrics(over: Partial<CustomerMetrics> & { id: string }): CustomerMetrics {
  return {
    name: over.id,
    revenue: 1000,
    grossRevenue: 1000,
    discount: 0,
    discountRate: null,
    initialRevenue: 1000,
    upsellRevenue: 0,
    recurringRevenue: 0,
    costs: {
      cogs: 400, shipping: 100, warranty: 0, refunds: 0, support: 0,
      returnHandling: 0, paymentFees: 0, commission: 0, installation: 0,
      consumables: 0, fulfilment: 0,
    },
    variableCosts: 500,
    contributionMargin: 500,
    contributionMarginPct: 0.5,
    cac: null,
    cacBasis: 'none',
    realizedLtv: 500,
    projectedLtv: 500,
    ltvCac: null,
    lifetimeProfit: 500,
    payback: { status: 'no_cac', months: null },
    units: 1,
    arpu: 1000,
    tenureDays: null,
    cohortMonth: null,
    channel: 'direct',
    regionCode: 'CA-ON',
    country: 'CA',
    ...over,
  } as CustomerMetrics;
}

function link(over: Partial<UnitBatchLink> & { serial: string; batch: string }): UnitBatchLink {
  return { customerId: null, shippedAt: null, ...over };
}

const asMap = (list: CustomerMetrics[]) => new Map(list.map(m => [m.id, m]));

describe('scaleMetrics', () => {
  it('scales additive figures by the unit share and leaves rates alone', () => {
    const m = metrics({ id: 'c1', contributionMarginPct: 0.5 });
    const half = scaleMetrics(m, 1, 2);

    expect(half.revenue).toBe(500);
    expect(half.costs.cogs).toBe(200);
    expect(half.variableCosts).toBe(250);
    expect(half.contributionMargin).toBe(250);
    expect(half.lifetimeProfit).toBe(250);
    expect(half.units).toBe(1);
    // A half-share of a customer earns the same margin percentage as the whole.
    expect(half.contributionMarginPct).toBe(0.5);
  });

  it('keeps a null CAC null rather than turning it into 0', () => {
    expect(scaleMetrics(metrics({ id: 'c1', cac: null }), 1, 2).cac).toBeNull();
  });

  it('scales a present CAC', () => {
    expect(scaleMetrics(metrics({ id: 'c1', cac: 300 }), 1, 2).cac).toBe(150);
  });

  it('treats a zero denominator as a zero share instead of dividing by zero', () => {
    const r = scaleMetrics(metrics({ id: 'c1' }), 0, 0);
    expect(r.revenue).toBe(0);
    expect(Number.isNaN(r.revenue)).toBe(false);
  });
});

describe('byBatch', () => {
  it('assigns a single-unit customer wholly to their batch', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('P100');
    expect(rows[0].revenue).toBe(1000);
    expect(rows[0].units).toBe(1);
    expect(rows[0].customers).toBe(1);
  });

  it('splits a customer who owns units from two batches', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P150', customerId: 'c1' }),
      link({ serial: '2', batch: 'P100', customerId: 'c1' }),
    ]);

    const p150 = rows.find(r => r.key === 'P150')!;
    const p100 = rows.find(r => r.key === 'P100')!;
    expect(p150.revenue).toBe(500);
    expect(p100.revenue).toBe(500);
    // The split conserves the total — this is the property the whole module rests on.
    expect(p150.revenue + p100.revenue).toBe(1000);
    expect(p150.mixedBatchCustomers).toBe(1);
    expect(p100.mixedBatchCustomers).toBe(1);
  });

  it('counts a two-unit same-batch customer once, not twice', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
      link({ serial: '2', batch: 'P100', customerId: 'c1' }),
    ]);

    expect(rows[0].customers).toBe(1);
    expect(rows[0].units).toBe(2);
    expect(rows[0].revenue).toBe(1000);
    expect(rows[0].mixedBatchCustomers).toBe(0);
  });

  it('counts an untraceable unit as unattributed instead of a zero-margin row', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
      link({ serial: '2', batch: 'P100', customerId: null }),
      link({ serial: '3', batch: 'P100', customerId: 'ghost' }),
    ]);

    expect(rows[0].coverage).toEqual({ shipped: 3, attributed: 1, unattributed: 2 });
    // The two unattributed units must not dilute profit per unit toward zero.
    expect(rows[0].units).toBe(1);
    expect(rows[0].profitPerUnit).toBe(500);
  });

  it('records the ship-date era of each batch', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' }), metrics({ id: 'c2' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1', shippedAt: '2026-04-15' }),
      link({ serial: '2', batch: 'P100', customerId: 'c2', shippedAt: '2026-07-21' }),
    ]);

    expect(rows[0].firstShipped).toBe('2026-04-15');
    expect(rows[0].lastShipped).toBe('2026-07-21');
  });

  it('orders batches by production chronology, not by profit', () => {
    const rows = byBatch(
      asMap([metrics({ id: 'a' }), metrics({ id: 'b' }), metrics({ id: 'c' })]),
      [
        link({ serial: '1', batch: 'P100', customerId: 'a' }),
        link({ serial: '2', batch: 'P50',  customerId: 'b' }),
        link({ serial: '3', batch: 'P150', customerId: 'c' }),
      ],
    );
    expect(rows.map(r => r.key)).toEqual(['P50', 'P150', 'P100']);
  });
});

describe('byBatchChronology', () => {
  it('follows the production timeline', () => {
    const sorted = [...BATCH_ORDER].reverse().map(key => ({ key })).sort(byBatchChronology);
    expect(sorted.map(s => s.key)).toEqual([...BATCH_ORDER]);
  });

  it('sorts an unknown batch after the known ones rather than dropping it', () => {
    const sorted = [{ key: 'P200' }, { key: 'P50' }].sort(byBatchChronology);
    expect(sorted.map(s => s.key)).toEqual(['P50', 'P200']);
  });
});

describe('byBatchRegion', () => {
  const setup = () => byBatchRegion(
    asMap([
      metrics({ id: 'on1', regionCode: 'CA-ON', country: 'CA' }),
      metrics({ id: 'on2', regionCode: 'CA-ON', country: 'CA' }),
      metrics({ id: 'tx1', regionCode: 'US-TX', country: 'US', contributionMargin: -200, lifetimeProfit: -200 }),
    ]),
    [
      link({ serial: '1', batch: 'P100', customerId: 'on1' }),
      link({ serial: '2', batch: 'P100', customerId: 'tx1' }),
      link({ serial: '3', batch: 'P150', customerId: 'on2' }),
    ],
  );

  it('builds a cell per batch/region pair that actually shipped', () => {
    const m = setup();
    expect(m.cells.has('P100|CA-ON')).toBe(true);
    expect(m.cells.has('P100|US-TX')).toBe(true);
    expect(m.cells.has('P150|CA-ON')).toBe(true);
    // P150 never shipped to Texas — no cell, which is not the same as a loss.
    expect(m.cells.has('P150|US-TX')).toBe(false);
  });

  it('orders regions by total units, busiest first', () => {
    expect(setup().regions[0]).toBe('CA-ON');
  });

  it('reports a batch/region gap as absence', () => {
    const gaps = batchRegionGaps(setup());
    expect(gaps.get('P150')).toContain('US-TX');
    expect(gaps.get('P100')).toEqual([]);
  });
});

describe('confounding guards', () => {
  // P150 sold into Canada only; P50N almost entirely into the US. Comparing
  // their regional performance directly compares countries, not batches.
  const reach = () => batchCountryReach(
    asMap([
      ...Array.from({ length: 6 }, (_, i) => metrics({ id: `ca${i}`, country: 'CA', regionCode: 'CA-ON' })),
      ...Array.from({ length: 9 }, (_, i) => metrics({ id: `us${i}`, country: 'US', regionCode: 'US-TX' })),
      metrics({ id: 'stray', country: 'CA', regionCode: 'CA-BC' }),
    ]),
    [
      ...Array.from({ length: 6 }, (_, i) => link({ serial: `c${i}`, batch: 'P150', customerId: `ca${i}` })),
      ...Array.from({ length: 9 }, (_, i) => link({ serial: `u${i}`, batch: 'P50N', customerId: `us${i}` })),
      link({ serial: 'stray', batch: 'P50N', customerId: 'stray' }),
    ],
  );

  it('counts units per country for each batch', () => {
    expect(reach().get('P150')).toEqual([{ country: 'CA', units: 6 }]);
    expect(reach().get('P50N')).toEqual([
      { country: 'US', units: 9 }, { country: 'CA', units: 1 },
    ]);
  });

  it('flags a batch that only ever sold into one country', () => {
    const flagged = confoundedBatches(reach());
    expect(flagged.map(f => f.batch)).toEqual(['P150', 'P50N']);
    expect(flagged.find(f => f.batch === 'P150')!.country).toBe('CA');
  });

  it('treats one stray cross-border unit as still single-country', () => {
    // P50N is 9 US + 1 CA = 90% US, which is confounded for comparison.
    expect(confoundedBatches(reach()).find(f => f.batch === 'P50N')).toBeDefined();
  });

  it('does not flag a genuinely cross-border batch', () => {
    const mixed = batchCountryReach(
      asMap([
        ...Array.from({ length: 5 }, (_, i) => metrics({ id: `a${i}`, country: 'CA' })),
        ...Array.from({ length: 5 }, (_, i) => metrics({ id: `b${i}`, country: 'US' })),
      ]),
      [
        ...Array.from({ length: 5 }, (_, i) => link({ serial: `a${i}`, batch: 'P100', customerId: `a${i}` })),
        ...Array.from({ length: 5 }, (_, i) => link({ serial: `b${i}`, batch: 'P100', customerId: `b${i}` })),
      ],
    );
    expect(confoundedBatches(mixed)).toEqual([]);
  });

  it('ignores a batch too small to say anything about', () => {
    const tiny = batchCountryReach(
      asMap([metrics({ id: 'c1', country: 'CA' })]),
      [link({ serial: '1', batch: 'P50', customerId: 'c1' })],
    );
    expect(confoundedBatches(tiny)).toEqual([]);
  });
});

describe('batchRegionExtremes', () => {
  const matrix = () => byBatchRegion(
    asMap([
      // rollup() derives lifetime profit from contribution margin less CAC, so
      // the margin is what has to differ between these regions.
      ...Array.from({ length: 3 }, (_, i) =>
        metrics({ id: `on${i}`, regionCode: 'CA-ON', country: 'CA', contributionMargin: 600 })),
      ...Array.from({ length: 3 }, (_, i) =>
        metrics({ id: `bc${i}`, regionCode: 'CA-BC', country: 'CA', contributionMargin: -300 })),
      metrics({ id: 'solo', regionCode: 'CA-YT', country: 'CA', contributionMargin: 9999 }),
    ]),
    [
      ...Array.from({ length: 3 }, (_, i) => link({ serial: `o${i}`, batch: 'P100', customerId: `on${i}` })),
      ...Array.from({ length: 3 }, (_, i) => link({ serial: `b${i}`, batch: 'P100', customerId: `bc${i}` })),
      link({ serial: 's', batch: 'P100', customerId: 'solo' }),
    ],
  );

  it('ranks the best and worst region by profit per unit', () => {
    const { best, worst } = batchRegionExtremes(matrix(), 'P100');
    expect(best!.regionCode).toBe('CA-ON');
    expect(worst!.regionCode).toBe('CA-BC');
  });

  it('excludes regions below the sample-size floor', () => {
    // The single Yukon unit is the most profitable on paper; it is noise.
    const { ranked } = batchRegionExtremes(matrix(), 'P100', 3);
    expect(ranked.map(r => r.regionCode)).not.toContain('CA-YT');
  });

  it('returns no worst when only one region clears the floor', () => {
    const { best, worst } = batchRegionExtremes(matrix(), 'P100', 6);
    expect(best).toBeNull();
    expect(worst).toBeNull();
  });
});

describe('attributionCoverage', () => {
  it('totals shipped and attributed units across batches', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
      link({ serial: '2', batch: 'P150', customerId: null }),
    ]);
    expect(attributionCoverage(rows)).toEqual({ shipped: 2, attributed: 1, unattributed: 1 });
  });
});
