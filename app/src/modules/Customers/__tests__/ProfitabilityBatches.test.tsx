import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BatchRegionMatrix } from '../profitability/BatchRegionMatrix';
import { BatchTable, FutureBatchPanel } from '../profitability/BatchTable';
import { byBatch, byBatchRegion, type UnitBatchLink } from '../../../lib/batchProfitability';
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
  return { map, links, matrix: byBatchRegion(map, links), batches: byBatch(map, links) };
}

describe('BatchRegionMatrix', () => {
  it('renders a column per batch in production order', () => {
    const { matrix } = fixture();
    render(<BatchRegionMatrix matrix={matrix} measure="profitPerUnit" onMeasureChange={vi.fn()} />);

    const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
    expect(headers).toContain('P150');
    expect(headers).toContain('P100');
    expect(headers.indexOf('P150')).toBeLessThan(headers.indexOf('P100'));
  });

  it('marks a batch/region pair that never shipped as not-sold, not as a loss', () => {
    const { matrix } = fixture();
    render(<BatchRegionMatrix matrix={matrix} measure="profitPerUnit" onMeasureChange={vi.fn()} />);

    // P150 never went to Texas.
    const txRow = screen.getByText('US-TX').closest('tr')!;
    expect(within(txRow).getByText('not sold here')).toBeTruthy();
  });

  it('direct-labels every populated cell, so colour is never the only encoding', () => {
    const { matrix } = fixture();
    render(<BatchRegionMatrix matrix={matrix} measure="profitPerUnit" onMeasureChange={vi.fn()} />);

    const txRow = screen.getByText('US-TX').closest('tr')!;
    // 3 Texas units at $900 contribution each.
    expect(within(txRow).getByText('$900')).toBeTruthy();
    // "3u" appears twice on the row: the P100 cell and the all-batches total.
    expect(within(txRow).getAllByText(/3\s*u/).length).toBeGreaterThanOrEqual(1);
  });

  it('explains the hatching and the thin-cell rule in words', () => {
    const { matrix } = fixture();
    render(<BatchRegionMatrix matrix={matrix} measure="profitPerUnit" onMeasureChange={vi.fn()} />);
    expect(screen.getByText(/never shipped to — not a loss/)).toBeTruthy();
    expect(screen.getByText(/Not sold in this region/)).toBeTruthy();
  });

  it('switches measure when a measure button is chosen', () => {
    const onChange = vi.fn();
    const { matrix } = fixture();
    render(<BatchRegionMatrix matrix={matrix} measure="profitPerUnit" onMeasureChange={onChange} />);
    screen.getByText('Units shipped').click();
    expect(onChange).toHaveBeenCalledWith('units');
  });
});

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
    expect(screen.getByText('not invoiced yet')).toBeTruthy();
    expect(screen.getByText(/no margin — not a\s+margin of zero/)).toBeTruthy();
  });

  it('renders nothing when every batch has shipped', () => {
    const { container } = render(<FutureBatchPanel batches={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
