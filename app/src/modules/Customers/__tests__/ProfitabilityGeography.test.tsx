import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { CustomerProfitability } from '../../../lib/customers';
import { DEFAULT_RATES } from '../../../lib/profitability';
import { regionName } from '../../../lib/regions';
import { REGION_SHAPES, MAP_VIEWBOX } from '../../../lib/regionShapes';

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

  it('draws an outline for every region, sold-into or not', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    expect(map.querySelectorAll('path[d]').length).toBe(REGION_SHAPES.length);
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

  it('says so on hover when a region has no customers', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.mouseEnter(within(map).getByText('NU').closest('g')!);
    expect(screen.getByText('Nunavut')).toBeInTheDocument();
    expect(screen.getByText('No customers here yet.')).toBeInTheDocument();
  });

  it('filters the whole tab to a region when it is clicked', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.click(within(map).getByText('ON').closest('g')!);
    // The clear-filters affordance reports how many customers survived.
    expect(screen.getByText(/Clear filters \(3 shown\)/)).toBeInTheDocument();
  });

  it('labels a region too small to print on with a gutter chip', () => {
    // Prince Edward Island is three pixels across. Its number has to live in
    // the right-hand column, and clicking that chip has to select PEI.
    mountGeography([0, 1, 2].map(i => row({
      id: `pe${i}`, region_code: 'CA-PE', region: 'PE', net_margin_cad: 500,
    })));
    const map = screen.getByRole('img', { name: /by province and state/i });
    const chip = within(map).getByText('PE');
    expect(chip.closest('g')!.querySelector('polyline')).not.toBeNull();
    fireEvent.click(chip.closest('g')!);
    expect(screen.getByText(/Clear filters \(3 shown\)/)).toBeInTheDocument();
  });

  it('keeps the rest of the map alive while one region is selected', () => {
    // Reported from the live tab: click Arizona, hover Texas, and the map
    // claimed Texas had no customers. The region filter was narrowing the
    // very dimension the map draws, so selecting one region hatched the
    // other sixty-three.
    const rows = [
      ...[0, 1, 2].map(i => row({
        id: `az${i}`, region_code: 'US-AZ', region: 'AZ', country: 'US', net_margin_cad: 500,
      })),
      ...[0, 1, 2].map(i => row({
        id: `tx${i}`, region_code: 'US-TX', region: 'TX', country: 'US', net_margin_cad: 300,
      })),
    ];
    mountGeography(rows);
    const map = screen.getByRole('img', { name: /by province and state/i });

    fireEvent.click(within(map).getByText('AZ').closest('g')!);
    expect(screen.getByText(/Clear filters \(3 shown\)/)).toBeInTheDocument();

    // Texas keeps its own readout rather than reporting itself as empty.
    fireEvent.mouseEnter(within(map).getByText('TX').closest('g')!);
    const readout = screen.getByText('Profit / customer').closest('dl')!.parentElement!;
    expect(within(readout).getByText('Texas')).toBeInTheDocument();
    expect(screen.queryByText(/No customers here/)).not.toBeInTheDocument();
  });

  it('still ranks every region while one is selected', () => {
    const rows = [
      ...[0, 1, 2].map(i => row({
        id: `on${i}`, region_code: 'CA-ON', region: 'ON', net_margin_cad: 600,
      })),
      ...[0, 1, 2].map(i => row({
        id: `ca${i}`, region_code: 'US-CA', region: 'CA', country: 'US', net_margin_cad: -400,
      })),
    ];
    mountGeography(rows);
    fireEvent.click(within(screen.getByRole('img', { name: /by province and state/i }))
      .getByText('ON').closest('g')!);
    // Both ends of the ranking survive the selection — otherwise the lists
    // collapse to the one region you just picked.
    const best = screen.getByText('Most profitable regions').closest('div')!;
    const worst = screen.getByText('Least profitable regions').closest('div')!;
    expect(within(best.parentElement!).getByText('Ontario')).toBeInTheDocument();
    expect(within(worst.parentElement!).getByText('California')).toBeInTheDocument();
  });

  it('says which kind of empty a hatched region is', () => {
    mountGeography(twoRegions());
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.mouseEnter(within(map).getByText('NU').closest('g')!);
    // No filter narrowing beyond the defaults the tab always applies, so the
    // honest reading of an empty Nunavut is "nobody has bought here".
    expect(screen.getByText(/No customers here/)).toBeInTheDocument();
  });

  it('distinguishes never-sold-here from filtered-out', () => {
    mountGeography(twoRegions());
    // A search narrows the map, so an empty Nunavut no longer means nobody
    // has ever bought there — only that nobody matching is left.
    fireEvent.change(screen.getByPlaceholderText('Search customer…'), {
      target: { value: 'Ontario' },
    });
    const map = screen.getByRole('img', { name: /by province and state/i });
    fireEvent.mouseEnter(within(map).getByText('NU').closest('g')!);
    expect(screen.getByText('No customers here match the current filters.')).toBeInTheDocument();
    expect(screen.queryByText('No customers here yet.')).not.toBeInTheDocument();
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

  it('has a name for every region it draws', () => {
    const unnamed = REGION_SHAPES.filter(s => regionName(s.code) === s.code);
    expect(unnamed).toEqual([]);
  });

  it('draws all thirteen provinces and all fifty-one US regions', () => {
    const ca = REGION_SHAPES.filter(s => s.code.startsWith('CA-'));
    const us = REGION_SHAPES.filter(s => s.code.startsWith('US-'));
    expect(ca).toHaveLength(13);
    expect(us).toHaveLength(51);
    expect(new Set(REGION_SHAPES.map(s => s.code)).size).toBe(REGION_SHAPES.length);
  });
});

describe('map geometry', () => {
  it('fits every outline inside the viewBox', () => {
    // The generator lays out the insets against the mainland; an off-by-one
    // there silently clips Hawaii or the callout column off the canvas.
    for (const shape of REGION_SHAPES) {
      const points = shape.d
        .split('M').filter(Boolean)
        .flatMap(sub => sub.replace('Z', '').split('L').map(p => p.split(',').map(Number)));
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(MAP_VIEWBOX.width);
        expect(y).toBeLessThanOrEqual(MAP_VIEWBOX.height);
      }
    }
  });

  it('keeps every label anchor inside the frame', () => {
    for (const shape of REGION_SHAPES) {
      expect(shape.labelX).toBeGreaterThan(0);
      expect(shape.labelX).toBeLessThan(MAP_VIEWBOX.width);
      expect(shape.labelY).toBeGreaterThan(0);
      expect(shape.labelY).toBeLessThan(MAP_VIEWBOX.height);
    }
  });
});
