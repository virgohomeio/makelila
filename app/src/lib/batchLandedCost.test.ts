import { describe, it, expect } from 'vitest';
import {
  USD_CAD, CLEARANCE_ENTRY_USD, LANDED_COST_ESTIMATES,
  landedCostPerUnit, sellableBand, costPerSellableUnit, batchCensus,
  type UnitCensus,
} from './batchLandedCost';

const census = (over: Partial<UnitCensus> = {}): UnitCensus => ({
  total: 0, scrap: 0, lost: 0, rework: 0, shipped: 0, ready: 0, ...over,
});

describe('landedCostPerUnit', () => {
  it('adds freight and clearance to an FOB batch — P50', () => {
    const l = landedCostPerUnit({ batchId: 'P50', invoiceUnitCostUsd: 900, unitCount: 50 });

    expect(l).not.toBeNull();
    expect(l!.invoiceUsd).toBe(900);
    expect(l!.freightUsd).toBe(80);
    // $288 entry spread over 50 units.
    expect(l!.clearanceUsd).toBeCloseTo(5.76, 2);
    expect(l!.landedUsd).toBeCloseTo(985.76, 2);
    expect(l!.landedCad).toBeCloseTo(985.76 * USD_CAD, 2);
    expect(l!.basis).toBe('estimated');
  });

  it('adds freight and clearance to an FOB batch — P150', () => {
    const l = landedCostPerUnit({ batchId: 'P150', invoiceUnitCostUsd: 345.28, unitCount: 150 });

    expect(l!.freightUsd).toBe(58);
    expect(l!.clearanceUsd).toBeCloseTo(1.92, 2);
    expect(l!.landedUsd).toBeCloseTo(405.2, 2);
  });

  it('charges no inbound freight to a CNF batch, whose price already carries it', () => {
    const l = landedCostPerUnit({ batchId: 'P100', invoiceUnitCostUsd: 314, unitCount: 100 });

    expect(l!.freightUsd).toBe(0);
    expect(l!.clearanceUsd).toBeCloseTo(2.88, 2);
    expect(l!.landedUsd).toBeCloseTo(316.88, 2);
  });

  it('still clears customs on a CNF batch — P50N', () => {
    const l = landedCostPerUnit({ batchId: 'P50N', invoiceUnitCostUsd: 314, unitCount: 50 });
    expect(l!.landedUsd).toBeCloseTo(319.76, 2);
  });

  it('falls back to the assumed unit cost when the factory has not invoiced yet', () => {
    const l = landedCostPerUnit({ batchId: 'P100X', invoiceUnitCostUsd: null, unitCount: 100 });

    expect(l!.invoiceUsd).toBe(314);
    expect(l!.invoiceAssumed).toBe(true);
    expect(l!.landedUsd).toBeCloseTo(316.88, 2);
    expect(l!.basis).toBe('estimated');
  });

  it('prefers a real invoice over the assumption once one lands', () => {
    const l = landedCostPerUnit({ batchId: 'P100X', invoiceUnitCostUsd: 290, unitCount: 100 });

    expect(l!.invoiceUsd).toBe(290);
    expect(l!.invoiceAssumed).toBe(false);
  });

  it('returns null for a batch with no invoice and no estimate — never a zero', () => {
    expect(landedCostPerUnit({ batchId: 'LILA-Mini', invoiceUnitCostUsd: null, unitCount: 0 })).toBeNull();
    expect(landedCostPerUnit({ batchId: 'P-UNKNOWN', invoiceUnitCostUsd: null, unitCount: 10 })).toBeNull();
  });

  it('costs an unknown batch off its invoice alone rather than dropping it', () => {
    const l = landedCostPerUnit({ batchId: 'P-UNKNOWN', invoiceUnitCostUsd: 400, unitCount: 10 });

    expect(l!.landedUsd).toBe(400);
    expect(l!.basis).toBe('invoiced');
    expect(l!.freightUsd).toBe(0);
  });

  it('does not divide by zero when the batch has no units', () => {
    const l = landedCostPerUnit({ batchId: 'P100', invoiceUnitCostUsd: 314, unitCount: 0 });
    expect(l!.clearanceUsd).toBe(0);
    expect(l!.landedUsd).toBe(314);
  });

  it('carries duty at the documented rate', () => {
    const l = landedCostPerUnit({ batchId: 'P100', invoiceUnitCostUsd: 314, unitCount: 100 });
    // HS 8479.89.90 is MFN duty-free; the exposure is documented, not charged.
    expect(l!.dutyUsd).toBe(0);
    expect(l!.dutyExposureUsd).toBeCloseTo(314 * 0.07, 2);
  });
});

describe('sellableBand', () => {
  it('writes off scrap, lost and rework at the low end, only scrap at the high end', () => {
    const band = sellableBand(census({ total: 150, scrap: 1, lost: 34, rework: 72 }));
    expect(band.low).toBe(43);
    expect(band.high).toBe(149);
  });

  it('collapses to a point when nothing is in doubt', () => {
    const band = sellableBand(census({ total: 100, scrap: 1 }));
    expect(band.low).toBe(99);
    expect(band.high).toBe(99);
  });

  it('never goes negative or exceeds the batch', () => {
    const band = sellableBand(census({ total: 5, scrap: 4, lost: 4, rework: 4 }));
    expect(band.low).toBe(0);
    expect(band.high).toBe(1);
  });
});

describe('costPerSellableUnit', () => {
  it('spreads the whole batch cost over the units that survive', () => {
    // P150: $405.20 landed x 150 bought, 43..149 sellable.
    const c = costPerSellableUnit(405.2, census({ total: 150, scrap: 1, lost: 34, rework: 72 }));

    expect(c!.high).toBeCloseTo(405.2 * 150 / 43, 2);   // ~1414
    expect(c!.low).toBeCloseTo(405.2 * 150 / 149, 2);   // ~408
  });

  it('equals the landed cost when the batch is clean', () => {
    const c = costPerSellableUnit(316.88, census({ total: 100 }));
    expect(c!.low).toBeCloseTo(316.88, 2);
    expect(c!.high).toBeCloseTo(316.88, 2);
  });

  it('is null rather than infinite when nothing survives', () => {
    expect(costPerSellableUnit(400, census({ total: 4, scrap: 4 }))).toBeNull();
  });

  it('is null when the batch is empty', () => {
    expect(costPerSellableUnit(400, census({ total: 0 }))).toBeNull();
  });
});

describe('batchCensus', () => {
  it('buckets unit statuses per batch and counts the rest as other', () => {
    const c = batchCensus([
      { batch: 'P100', status: 'shipped' },
      { batch: 'P100', status: 'shipped' },
      { batch: 'P100', status: 'ready' },
      { batch: 'P100', status: 'scrap' },
      { batch: 'P100', status: 'team-test' },
      { batch: 'P150', status: 'rework' },
      { batch: 'P150', status: 'lost' },
    ]);

    expect(c.get('P100')).toEqual({
      total: 5, scrap: 1, lost: 0, rework: 0, shipped: 2, ready: 1,
    });
    expect(c.get('P150')).toEqual({
      total: 2, scrap: 0, lost: 1, rework: 1, shipped: 0, ready: 0,
    });
  });

  it('ignores units with no batch', () => {
    const c = batchCensus([{ batch: null, status: 'shipped' }]);
    expect(c.size).toBe(0);
  });
});

describe('the estimate table itself', () => {
  it('documents every assumption it charges', () => {
    for (const [id, e] of Object.entries(LANDED_COST_ESTIMATES)) {
      expect(e.note, `${id} must explain its derivation`).toBeTruthy();
      expect(e.incoterm, `${id} must record its incoterm`).toBeTruthy();
      expect(e.freightPerUnitUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it('charges inbound freight to FOB batches and none to CNF ones', () => {
    for (const [, e] of Object.entries(LANDED_COST_ESTIMATES)) {
      if (e.incoterm.startsWith('CNF')) expect(e.freightPerUnitUsd).toBe(0);
      else expect(e.freightPerUnitUsd).toBeGreaterThan(0);
    }
  });

  it('holds the clearance entry and FX figures the estimates were built on', () => {
    expect(CLEARANCE_ENTRY_USD).toBeCloseTo(288, 0);
    expect(USD_CAD).toBeCloseTo(1.388889, 6);
  });
});

/**
 *  The five real batches, as of 2026-09-04, with the figures reported to
 *  Finance. If a rate or an estimate is revised, these numbers move and this
 *  block is the record of what they moved from.
 */
describe('the production batches as they stand today', () => {
  const REAL = [
    { id: 'P50',   invoice: 900,    bought: 50,  scrap: 16, lost: 16, rework: 2,  shipped: 16, ready: 0 },
    { id: 'P150',  invoice: 345.28, bought: 150, scrap: 1,  lost: 34, rework: 72, shipped: 42, ready: 1 },
    { id: 'P50N',  invoice: 314,    bought: 50,  scrap: 0,  lost: 0,  rework: 1,  shipped: 30, ready: 0 },
    { id: 'P100',  invoice: 314,    bought: 100, scrap: 1,  lost: 0,  rework: 0,  shipped: 87, ready: 6 },
  ];

  const costed = REAL.map(b => {
    const landed = landedCostPerUnit({
      batchId: b.id, invoiceUnitCostUsd: b.invoice, unitCount: b.bought,
    })!;
    const census: UnitCensus = {
      total: b.bought, scrap: b.scrap, lost: b.lost,
      rework: b.rework, shipped: b.shipped, ready: b.ready,
    };
    return { id: b.id, landed, census, per: costPerSellableUnit(landed.landedUsd, census)! };
  });
  const of = (id: string) => costed.find(c => c.id === id)!;

  it('lands each batch where it was reported', () => {
    expect(of('P50').landed.landedUsd).toBeCloseTo(985.76, 2);
    expect(of('P150').landed.landedUsd).toBeCloseTo(405.2, 2);
    expect(of('P50N').landed.landedUsd).toBeCloseTo(319.76, 2);
    expect(of('P100').landed.landedUsd).toBeCloseTo(316.88, 2);
  });

  it('costs a sellable unit where it was reported', () => {
    // Conservative end of the band — rework and lost both written off.
    expect(of('P50').per.high).toBeCloseTo(3080.5, 1);
    expect(of('P150').per.high).toBeCloseTo(1413.5, 1);
    expect(Math.round(of('P50N').per.high)).toBe(326);
    expect(Math.round(of('P100').per.high)).toBe(320);
  });

  it('shows the P150 → P100 gap is yield, not procurement', () => {
    const invoiceGap = of('P150').landed.invoiceUsd / of('P100').landed.invoiceUsd;
    const sellableGap = of('P150').per.high / of('P100').per.high;

    expect(invoiceGap).toBeLessThan(1.15);   // ~9% on the invoice
    expect(sellableGap).toBeGreaterThan(4);  // ~4.4x once scrap is paid for
  });

  it('keeps P150 the widest band, because its yield is unresolved', () => {
    const spread = (id: string) => of(id).per.high / of(id).per.low;
    expect(spread('P150')).toBeGreaterThan(spread('P100'));
    expect(spread('P100')).toBeCloseTo(1, 3);
  });
});
