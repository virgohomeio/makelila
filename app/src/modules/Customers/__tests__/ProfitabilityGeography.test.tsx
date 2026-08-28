import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { CustomerProfitability } from '../../../lib/customers';
import { DEFAULT_RATES } from '../../../lib/profitability';
import { regionName, REGION_TILES } from '../../../lib/regions';
import { GeoMap } from '../profitability/GeoMap';

const { profitabilityMock } = vi.hoisted(() => ({ profitabilityMock: vi.fn() }));

vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return {
    ...actual,
    useCustomerProfitability: profitabilityMock,
    useProfitabilityRates: () => ({ rates: DEFAULT_RATES, loading: false, error: null }),
    useAcquisitionSpend: () => ({ spend: [], loading: false, error: null }),
  };
});

import { ProfitabilityTab } from '../ProfitabilityTab';

function row(over: Partial<CustomerProfitability> = {}): CustomerProfitability {
  return {
    id: 'c1', full_name: 'Test Customer', email: 't@example.com',
    country: 'CA', region: 'ON', region_code: 'CA-ON', onboard_date: '2026-01-15',
    acquisition_channel: 'paid_social', acquisition_campaign: null,
    first_order_at: '2026-01-10T00:00:00Z', last_order_at: '2026-01-10T00:00:00Z',
    acquired_on: '2026-01-10',
    revenue_cad: 1000, gross_revenue_cad: 1000, discount_cad: 0,
    initial_revenue_cad: 1000, initial_discount_cad: 0, upsell_revenue_cad: 0,
    recurring_revenue_cad: 0, tax_collected_cad: 0,
    sale_cogs_cad: 400, sale_shipping_cad: 100,
    expected_warranty_cost_cad: 0, expected_refund_cad: 0, settled_refund_cad: 0,
    support_cost_cad: 0,
    return_handling_cad: 0, return_stocking_cad: 0,
    return_inspection_cad: 0, return_freight_cad: 0, returns_handled: 0,
    payment_fee_cad: 0, sales_commission_cad: 0, installation_cost_cad: 0,
    consumables_cost_cad: 0, consumable_item_count: 0, shipping_invoiced_count: 0,
    legacy_shipping_cad: 0, legacy_shipment_count: 0,
    fulfilment_cost_cad: 0, fulfilment_order_count: 0,
    net_margin_cad: 500,
    order_count: 1, units_shipped_count: 1,
    replacement_count: 0, open_replacement_count: 0,
    cogs_actual_count: 1, cogs_modelled_count: 0,
    shipping_costed_count: 1, shipping_uncosted_count: 0,
    refund_count: 0, in_flight_refund_count: 0,
    ticket_count: 0, open_warranty_ticket_count: 0,
    diagnosis_call_count: 0, diagnosis_minutes: 0, diagnosis_noshow_count: 0,
    is_team_member: false,
    ...over,
  };
}

/** Three Ontario customers who make money, three Californians who lose it.
 *  Enough per region to clear the 3-customer floor the ranking uses. */
function twoRegions(): CustomerProfitability[] {
  const on = [0, 1, 2].map(i => row({
    id: `on${i}`, full_name: `Ontario ${i}`, region_code: 'CA-ON', region: 'ON', country: 'CA',
    net_margin_cad: 600,
  }));
  const ca = [0, 1, 2].map(i => row({
    id: `ca${i}`, full_name: `California ${i}`, region_code: 'US-CA', region: 'CA', country: 'US',
    net_margin_cad: -400,
  }));
  return [...on, ...ca];
}

function mountGeography(rows: CustomerProfitability[]) {
  profitabilityMock.mockReturnValue({ rows, loading: false, error: null });
  render(<ProfitabilityTab />);
  fireEvent.click(screen.getByRole('tab', { name: 'Geography' }));
}

describe('ProfitabilityTab — geography', () => {
  it('compares provinces and states, not just countries', () => {
    mountGeography(twoRegions());
    // The old view only knew CA/US/Other. Both regions must appear by name.
    expect(screen.getAllByText('Ontario').length).toBeGreaterThan(0);
    expect(screen.getAllByText('California').length).toBeGreaterThan(0);
  });

  it('ranks the most and least profitable regions apart', () => {
    mountGeography(twoRegions());
    const best = screen.getByText('Most profitable regions').closest('div')!;
    const worst = screen.getByText('Least profitable regions').closest('div')!;
    expect(within(best.parentElement!).getByText('Ontario')).toBeInTheDocument();
    expect(within(worst.parentElement!).getByText('California')).toBeInTheDocument();
  });

  it('draws a map tile for every region, sold-into or not', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    // ON and CA carry values; a region we have never sold into is still drawn.
    expect(within(map).getByText('ON')).toBeInTheDocument();
    expect(within(map).getByText('NU')).toBeInTheDocument();
  });

  it('shows a region detail readout on hover', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.mouseEnter(within(map).getByText('ON').closest('g')!);
    expect(screen.getByText('Profit / customer')).toBeInTheDocument();
  });

  it('filters the whole tab to a region when its tile is clicked', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.click(within(map).getByText('ON').closest('g')!);
    // The clear-filters affordance reports how many customers survived.
    expect(screen.getByText(/Clear filters \(3 shown\)/)).toBeInTheDocument();
  });

  it('keeps a region with too few customers out of the ranking', () => {
    mountGeography([row({ id: 'solo', region_code: 'CA-NS', region: 'NS' })]);
    expect(screen.getAllByText(/Not enough data yet/).length).toBeGreaterThan(0);
  });
});

describe('region reference data', () => {
  it('names a province and a state without confusing CA with CA', () => {
    expect(regionName('CA-CA')).toBe('CA-CA');   // no such province — passes through
    expect(regionName('CA-ON')).toBe('Ontario');
    expect(regionName('US-CA')).toBe('California');
    expect(regionName(null)).toBe('Unknown');
  });

  it('gives every tile a unique grid position', () => {
    const seen = new Set(REGION_TILES.map(t => `${t.row}:${t.col}`));
    expect(seen.size).toBe(REGION_TILES.length);
  });

  it('has a name for every tile it draws', () => {
    const unnamed = REGION_TILES.filter(t => regionName(t.code) === t.code);
    expect(unnamed).toEqual([]);
  });
});

describe('map geometry', () => {
  it('fits every tile inside the viewBox', () => {
    // The bottom row — Hawaii, Texas, Florida — sits below the last grid row
    // once the country captions push everything down, so the canvas has to be
    // taller than rows × cell or those three states are clipped away.
    render(<GeoMapProbe />);
    const svg = screen.getByRole('img', { name: /by province and state/i });
    const [, , vbWidth, vbHeight] = svg.getAttribute('viewBox')!.split(' ').map(Number);

    const boxes = Array.from(svg.querySelectorAll('g[transform]')).map(g => {
      const [x, y] = /translate\(([-\d.]+),\s*([-\d.]+)\)/
        .exec(g.getAttribute('transform')!)!.slice(1).map(Number);
      const rect = g.querySelector('rect')!;
      return {
        right:  x + Number(rect.getAttribute('width')),
        bottom: y + Number(rect.getAttribute('height')),
      };
    });

    expect(boxes.length).toBe(REGION_TILES.length);
    expect(Math.max(...boxes.map(b => b.bottom))).toBeLessThanOrEqual(vbHeight);
    expect(Math.max(...boxes.map(b => b.right))).toBeLessThanOrEqual(vbWidth);
  });
});

/** The map on its own, with no customers — geometry does not depend on data. */
function GeoMapProbe() {
  return (
    <GeoMap
      regions={[]}
      measure="profitPerCustomer"
      onMeasureChange={() => {}}
      onSelect={() => {}}
      selected={null}
    />
  );
}
