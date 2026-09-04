import { describe, it, expect } from 'vitest';
import type { CustomerMetrics } from './profitability';
import {
  BATCH_ORDER, byBatch, byBatchChronology, scaleMetrics,
  singleMarketBatches, dominantMarketShare,
  attributionCoverage, modelledCostBatches, type UnitBatchLink,
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

describe('attributionCoverage', () => {
  it('totals shipped and attributed units across batches', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
      link({ serial: '2', batch: 'P150', customerId: null }),
    ]);
    expect(attributionCoverage(rows)).toEqual({ shipped: 2, attributed: 1, unattributed: 1 });
  });
});

describe('COGS basis', () => {
  const basis = (m: Record<string, { actual: number; modelled: number }>) =>
    (id: string) => m[id];

  it('sums the basis counts of every customer behind a batch', () => {
    const rows = byBatch(
      asMap([metrics({ id: 'c1' }), metrics({ id: 'c2' })]),
      [
        link({ serial: '1', batch: 'P100', customerId: 'c1' }),
        link({ serial: '2', batch: 'P100', customerId: 'c2' }),
      ],
      basis({ c1: { actual: 3, modelled: 1 }, c2: { actual: 1, modelled: 0 } }),
    );
    expect(rows[0].cogsBasis).toEqual({ actual: 4, modelled: 1 });
    expect(rows[0].cogsModelledPct).toBeCloseTo(0.2);
  });

  it('reports a fully modelled batch as 100% modelled', () => {
    const rows = byBatch(
      asMap([metrics({ id: 'c1' })]),
      [link({ serial: '1', batch: 'P150', customerId: 'c1' })],
      basis({ c1: { actual: 0, modelled: 2 } }),
    );
    expect(rows[0].cogsModelledPct).toBe(1);
    expect(modelledCostBatches(rows).map(r => r.key)).toEqual(['P150']);
  });

  it('leaves the basis unknown rather than guessing when no lookup is given', () => {
    const rows = byBatch(asMap([metrics({ id: 'c1' })]), [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
    ]);
    expect(rows[0].cogsModelledPct).toBeNull();
    // An unknown basis must not be flagged as modelled.
    expect(modelledCostBatches(rows)).toEqual([]);
  });

  it('does not flag a batch that is mostly invoiced', () => {
    const rows = byBatch(
      asMap([metrics({ id: 'c1' })]),
      [link({ serial: '1', batch: 'P100', customerId: 'c1' })],
      basis({ c1: { actual: 7, modelled: 3 } }),
    );
    expect(modelledCostBatches(rows)).toEqual([]);
  });
});

describe('byBatch landed cost', () => {
  const census = new Map([
    ['P150', { total: 150, scrap: 1, lost: 34, rework: 72, shipped: 42, ready: 1 }],
    ['P100', { total: 100, scrap: 1, lost: 0, rework: 0, shipped: 87, ready: 6 }],
  ]);
  const facts = new Map([
    ['P150', { unitCount: 150, unitCostUsd: 345.28 }],
    ['P100', { unitCount: 100, unitCostUsd: 314 }],
  ]);

  const run = () => byBatch(
    asMap([metrics({ id: 'c1' }), metrics({ id: 'c2' })]),
    [
      link({ serial: 's1', batch: 'P150', customerId: 'c1' }),
      link({ serial: 's2', batch: 'P100', customerId: 'c2' }),
    ],
    undefined,
    { census, facts },
  );

  it('normalises an FOB batch onto landed cost', () => {
    const p150 = run().find(b => b.key === 'P150')!;

    expect(p150.landed!.landedUsd).toBeCloseTo(405.2, 2);
    expect(p150.landed!.basis).toBe('estimated');
    expect(p150.landed!.incoterm).toBe('FOB Ningbo');
  });

  it('leaves a CNF batch on its invoice plus clearance only', () => {
    const p100 = run().find(b => b.key === 'P100')!;

    expect(p100.landed!.freightUsd).toBe(0);
    expect(p100.landed!.landedUsd).toBeCloseTo(316.88, 2);
  });

  it('spreads batch cost over surviving units, widest where yield is unresolved', () => {
    const rows = run();
    const p150 = rows.find(b => b.key === 'P150')!;
    const p100 = rows.find(b => b.key === 'P100')!;

    expect(p150.costPerSellable!.high).toBeCloseTo(405.2 * 150 / 43, 1);
    expect(p150.costPerSellable!.low).toBeCloseTo(405.2 * 150 / 149, 1);
    // P100 has nothing in doubt, so its band is a point.
    expect(p100.costPerSellable!.low).toBeCloseTo(p100.costPerSellable!.high, 6);
  });

  it('leaves margin columns untouched — landed cost sits beside COGS, not in it', () => {
    const withLanded = run().find(b => b.key === 'P100')!;
    const without = byBatch(
      asMap([metrics({ id: 'c2' })]),
      [link({ serial: 's2', batch: 'P100', customerId: 'c2' })],
    ).find(b => b.key === 'P100')!;

    expect(withLanded.costs.cogs).toBe(without.costs.cogs);
    expect(withLanded.contributionMargin).toBe(without.contributionMargin);
    expect(withLanded.lifetimeProfit).toBe(without.lifetimeProfit);
  });

  it('carries no landed cost when no inputs are supplied, rather than a zero', () => {
    const rows = byBatch(
      asMap([metrics({ id: 'c1' })]),
      [link({ serial: 's1', batch: 'P150', customerId: 'c1' })],
    );
    expect(rows[0].landed).toBeNull();
    expect(rows[0].costPerSellable).toBeNull();
  });
});

describe('market mix', () => {
  // The batch tab compares batches only. The mix is context for that
  // comparison — it must never become a per-region margin.
  const mixed = () => byBatch(
    new Map([
      ...Array.from({ length: 6 }, (_, i) =>
        [`ca${i}`, metrics({ id: `ca${i}`, country: 'CA', regionCode: 'CA-ON' })] as const),
      ...Array.from({ length: 4 }, (_, i) =>
        [`us${i}`, metrics({ id: `us${i}`, country: 'US', regionCode: 'US-TX' })] as const),
      ['stray', metrics({ id: 'stray', country: 'CA', regionCode: 'CA-BC' })] as const,
    ]),
    [
      ...Array.from({ length: 6 }, (_, i) => link({ serial: `c${i}`, batch: 'P150', customerId: `ca${i}` })),
      ...Array.from({ length: 4 }, (_, i) => link({ serial: `u${i}`, batch: 'P100', customerId: `us${i}` })),
      link({ serial: 's', batch: 'P100', customerId: 'stray' }),
    ],
  );

  it('counts units per country, largest market first', () => {
    const p100 = mixed().find(b => b.key === 'P100')!;
    expect(p100.marketMix).toEqual([{ country: 'US', units: 4 }, { country: 'CA', units: 1 }]);
    expect(mixed().find(b => b.key === 'P150')!.marketMix).toEqual([{ country: 'CA', units: 6 }]);
  });

  it('reports the dominant market share', () => {
    const p150 = mixed().find(b => b.key === 'P150')!;
    expect(dominantMarketShare(p150.marketMix)).toEqual({ country: 'CA', share: 1 });
  });

  it('returns null when no country is known', () => {
    expect(dominantMarketShare([{ country: 'unknown', units: 3 }])).toBeNull();
  });

  it('flags a batch that sold into essentially one country', () => {
    const flagged = singleMarketBatches(mixed());
    expect(flagged.map(f => f.batch)).toEqual(['P150']);
    expect(flagged[0].country).toBe('CA');
  });

  it('does not flag a genuinely cross-border batch', () => {
    // P100 here is 4 US / 1 CA = 80%, under the 90% threshold.
    expect(singleMarketBatches(mixed()).map(f => f.batch)).not.toContain('P100');
  });

  it('ignores a batch too small to describe as a market', () => {
    const tiny = byBatch(
      new Map([['c1', metrics({ id: 'c1', country: 'CA' })]]),
      [link({ serial: '1', batch: 'P50', customerId: 'c1' })],
    );
    expect(singleMarketBatches(tiny)).toEqual([]);
  });
});
