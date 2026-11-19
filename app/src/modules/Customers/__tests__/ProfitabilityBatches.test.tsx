import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BatchTable, FutureBatchPanel } from '../profitability/BatchTable';
import { byBatch, type UnitBatchLink } from '../../../lib/batchProfitability';
import type { CustomerMetrics } from '../../../lib/profitability';

function metrics(over: Partial<CustomerMetrics> & { id: string }): CustomerMetrics {
  return {
    name: over.id,
    revenue: 1000, grossRevenue: 1000, discount: 0, discountRate: null,
    initialRevenue: 1000, upsellRevenue: 0, recurringRevenue: 0,
    costs: {
      cogs: 400, shipping: 100, warranty: 0, refunds: 0, support: 0,
      returnHandling: 0, paymentFees: 0, commission: 0, installation: 0,
      consumables: 0, fulfilment: 0,
    },
    variableCosts: 500, contributionMargin: 500, contributionMarginPct: 0.5,
    cac: null, cacBasis: 'none', realizedLtv: 500, projectedLtv: 500,
    ltvCac: null, lifetimeProfit: 500, payback: { status: 'no_cac', months: null },
    units: 1, arpu: 1000, tenureDays: null, cohortMonth: null,
    channel: 'direct', regionCode: 'CA-ON', country: 'CA',
    ...over,
  } as CustomerMetrics;
}

const link = (o: Partial<UnitBatchLink> & { serial: string; batch: string }): UnitBatchLink =>
  ({ customerId: null, shippedAt: null, ...o });

/** Mirrors the real shape: P100 sold into Ontario and Texas, P150 only Ontario. */
function fixture() {
  const people = [
    ...Array.from({ length: 4 }, (_, i) =>
      metrics({ id: `on${i}`, regionCode: 'CA-ON', country: 'CA', contributionMargin: -200 })),
    ...Array.from({ length: 3 }, (_, i) =>
      metrics({ id: `tx${i}`, regionCode: 'US-TX', country: 'US', contributionMargin: 900 })),
    metrics({ id: 'solo', regionCode: 'CA-BC', country: 'CA', contributionMargin: 5000 }),
  ];
  const links = [
    ...Array.from({ length: 2 }, (_, i) => link({ serial: `a${i}`, batch: 'P100', customerId: `on${i}` })),
    ...Array.from({ length: 3 }, (_, i) => link({ serial: `t${i}`, batch: 'P100', customerId: `tx${i}` })),
    ...Array.from({ length: 2 }, (_, i) => link({ serial: `b${i}`, batch: 'P150', customerId: `on${i + 2}` })),
    link({ serial: 'solo', batch: 'P100', customerId: 'solo' }),
  ];
  const map = new Map(people.map(p => [p.id, p]));
  return { map, links, batches: byBatch(map, links) };
}

describe('BatchTable', () => {
  it('lists batches oldest first with their shipping era', () => {
    const { batches } = fixture();
    render(<BatchTable batches={batches} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('P150');
    expect(rows[1].textContent).toContain('P100');
  });

  it('shows attribution coverage so an untraced unit is visible', () => {
    const map = new Map([['c1', metrics({ id: 'c1' })]]);
    const batches = byBatch(map, [
      link({ serial: '1', batch: 'P100', customerId: 'c1' }),
      link({ serial: '2', batch: 'P100', customerId: null }),
    ]);
    render(<BatchTable batches={batches} />);
    expect(screen.getByText('1/2')).toBeTruthy();
  });
});

describe('FutureBatchPanel', () => {
  it('shows an unshipped batch without inventing a margin for it', () => {
    render(<FutureBatchPanel batches={[{
      id: 'P100X', unitCount: 100, unitCostUsd: null,
      expectedArrival: null, arrivedAt: null,
      manufacturer: 'LC', destination: 'MicroArt, Markham (projected)',
    }]} />);

    expect(screen.getByText('P100X')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    // Costed at P100 parity until LC invoices it, and marked as an estimate so
    // the assumption never reads as a quote.
    expect(screen.getByText(/\$317 USD/)).toBeTruthy();
    expect(screen.getByText('est')).toBeTruthy();
    expect(screen.getByText(/no margin — not a\s+margin of zero/)).toBeTruthy();
  });

  it('says so plainly for a batch with no invoice and no estimate', () => {
    render(<FutureBatchPanel batches={[{
      id: 'LILA-Mini', unitCount: 40, unitCostUsd: null,
      expectedArrival: null, arrivedAt: null,
      manufacturer: 'LC', destination: null,
    }]} />);

    expect(screen.getByText('not invoiced yet')).toBeTruthy();
  });

  it('renders nothing when every batch has shipped', () => {
    const { container } = render(<FutureBatchPanel batches={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('BatchTable landed cost columns', () => {
  const census = new Map([
    ['P150', { total: 150, scrap: 1, lost: 34, rework: 72, shipped: 42, ready: 1 }],
    ['P100', { total: 100, scrap: 1, lost: 0, rework: 0, shipped: 87, ready: 6 }],
  ]);
  const facts = new Map([
    ['P150', { unitCount: 150, unitCostUsd: 345.28 }],
    ['P100', { unitCount: 100, unitCostUsd: 314 }],
  ]);

  function withLanded() {
    const { map, links } = fixture();
    return byBatch(map, links, undefined, { census, facts });
  }

  const rowFor = (label: string) =>
    screen.getAllByRole('row').find(r => within(r).queryByText(label))!;

  it('shows landed cost in CAD, marked as an estimate', () => {
    render(<BatchTable batches={withLanded()} />);

    // P150: $405.20 USD x 1.388889 = $563 CAD.
    expect(within(rowFor('P150')).getByText('$563')).toBeTruthy();
    // P100: $316.88 USD = $440 CAD.
    expect(within(rowFor('P100')).getByText('$440')).toBeTruthy();
    expect(screen.getAllByText('est').length).toBe(2);
  });

  it('shows a range for a batch whose yield is unresolved and a point for a clean one', () => {
    render(<BatchTable batches={withLanded()} />);

    expect(within(rowFor('P150')).getByText('$567–$1,963')).toBeTruthy();
    expect(within(rowFor('P100')).getByText('$445')).toBeTruthy();
  });

  it('shows yield as a band where rework and lost units are unsettled', () => {
    render(<BatchTable batches={withLanded()} />);

    expect(within(rowFor('P150')).getByText('29%–99%')).toBeTruthy();
    expect(within(rowFor('P100')).getByText('99%')).toBeTruthy();
  });

  it('says unpriced rather than showing a zero when a batch cannot be costed', () => {
    const { map, links } = fixture();
    render(<BatchTable batches={byBatch(map, links)} />);

    expect(screen.getAllByText('unpriced').length).toBeGreaterThan(0);
  });
});

describe('BatchTable market column', () => {
  it('shows the country mix as context, not as a regional margin', () => {
    const { batches } = fixture();
    render(<BatchTable batches={batches} />);

    // P150 sold Canada-only in the fixture; P100 is split.
    const p150 = screen.getByText('P150').closest('tr')!;
    expect(within(p150).getByText('100% CA')).toBeTruthy();

    const p100 = screen.getByText('P100').closest('tr')!;
    expect(within(p100).getByText(/% US · .*% CA|% CA · .*% US/)).toBeTruthy();
  });

  it('never renders a province or state anywhere in the batch view', () => {
    const { batches } = fixture();
    const { container } = render(<BatchTable batches={batches} />);
    expect(container.textContent).not.toMatch(/CA-ON|US-TX|Ontario|Texas/);
  });
});
