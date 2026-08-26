import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CustomerProfitability } from '../../../lib/customers';
import { DEFAULT_RATES } from '../../../lib/profitability';

const { profitabilityMock } = vi.hoisted(() => ({ profitabilityMock: vi.fn() }));

vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return {
    ...actual,
    useCustomerProfitability: profitabilityMock,
    // The rates and spend tables are reference data; the card assertions below
    // do not depend on them, and stubbing them keeps Supabase out of the test.
    useProfitabilityRates: () => ({ rates: DEFAULT_RATES, loading: false, error: null }),
    useAcquisitionSpend: () => ({ spend: [], loading: false, error: null }),
  };
});

import { ProfitabilityTab } from '../ProfitabilityTab';

function row(over: Partial<CustomerProfitability> = {}): CustomerProfitability {
  return {
    id: 'c1', full_name: 'Ronald Hatch', email: 'rdhridgeback@gmail.com',
    country: 'US', region: 'CA', region_code: 'US-CA', onboard_date: '2026-05-01',
    acquisition_channel: 'organic_search', acquisition_campaign: null,
    first_order_at: '2026-05-01T00:00:00Z', last_order_at: '2026-05-01T00:00:00Z',
    acquired_on: '2026-05-01',
    revenue_cad: 1000, gross_revenue_cad: 1000, discount_cad: 0,
    initial_revenue_cad: 1000, initial_discount_cad: 0, upsell_revenue_cad: 0,
    recurring_revenue_cad: 0,
    payment_fee_cad: 0, sales_commission_cad: 0, installation_cost_cad: 0,
    consumables_cost_cad: 0, consumable_item_count: 0, shipping_invoiced_count: 0,
    units_shipped_count: 1,
    tax_collected_cad: 0,
    sale_cogs_cad: 400, sale_shipping_cad: 100,
    expected_warranty_cost_cad: 0, expected_refund_cad: 0, settled_refund_cad: 0,
    support_cost_cad: null, net_margin_cad: 500,
    order_count: 1, replacement_count: 0, open_replacement_count: 0,
    cogs_actual_count: 1, cogs_modelled_count: 0,
    shipping_costed_count: 1, shipping_uncosted_count: 0,
    refund_count: 0, in_flight_refund_count: 0,
    ticket_count: 0, open_warranty_ticket_count: 0,
    diagnosis_call_count: 0, diagnosis_minutes: 0, diagnosis_noshow_count: 0,
    return_handling_cad: null, return_stocking_cad: null,
    return_inspection_cad: null, return_freight_cad: null, returns_handled: 0,
    is_team_member: false,
    ...over,
  };
}

/** The tab now opens on the executive overview, and the customer list defaults
 *  to the table. Every assertion below is about the per-customer card, so mount
 *  navigates to it: Customers view, cards layout. */
function mount(rows: CustomerProfitability[]) {
  profitabilityMock.mockReturnValue({ rows, loading: false, error: null });
  render(<ProfitabilityTab />);
  fireEvent.click(screen.getByRole('tab', { name: 'Customers' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
}

describe('ProfitabilityTab — diagnosis-call support cost', () => {
  it('shows cost and talk time once the rate is set', () => {
    // 79.61 min across 3 calls, priced by the view.
    mount([row({ support_cost_cad: 132.68, diagnosis_call_count: 3, diagnosis_minutes: 79.61, net_margin_cad: 367.32 })]);
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText(/1h 20m/)).toBeInTheDocument();
    expect(screen.getByText('3 diagnosis')).toBeInTheDocument();
  });

  it('says "rate not set" instead of $0.00 when the rate is unconfigured', () => {
    // The whole point of the NULL: an unpriced call must not read as a free one.
    mount([row({ support_cost_cad: null, diagnosis_call_count: 3, diagnosis_minutes: 79.61 })]);
    expect(screen.getAllByText(/rate not set/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\(1h 20m\)/)).not.toBeInTheDocument();
  });

  it('bills no-shows but breaks them out as a subset of the call count', () => {
    // 3 calls totalling 45 min, 2 of which the customer never joined. All 3
    // are in the cost; the no-show count is a subset, not an addition.
    mount([row({ support_cost_cad: 75.0, diagnosis_call_count: 3, diagnosis_minutes: 45, diagnosis_noshow_count: 2 })]);
    expect(screen.getByText(/2 no-show/)).toBeInTheDocument();
    expect(screen.getByText('3 diagnosis')).toBeInTheDocument();
    expect(screen.getByText(/45m/)).toBeInTheDocument();
  });

  it('still prices a customer whose calls were ALL no-shows', () => {
    // Fred Rice: one booking, never joined. The team's time was still spent,
    // so the card must show a cost rather than an empty Support line.
    mount([row({
      full_name: 'Fred Rice', order_count: 0, revenue_cad: 0,
      sale_cogs_cad: 0, sale_shipping_cad: 0, net_margin_cad: -14.23,
      support_cost_cad: 14.23, diagnosis_call_count: 1,
      diagnosis_minutes: 11.38, diagnosis_noshow_count: 1,
    })]);
    expect(screen.getByText('Fred Rice')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText(/1 no-show/)).toBeInTheDocument();
  });

  it('keeps a customer visible when calls are their only activity', () => {
    // Antonio Gonsalves has a diagnosis call but no orders on file.
    mount([row({
      full_name: 'Antonio Gonsalves', order_count: 0, revenue_cad: 0,
      sale_cogs_cad: 0, sale_shipping_cad: 0, net_margin_cad: 0,
      support_cost_cad: 30.75, diagnosis_call_count: 1, diagnosis_minutes: 18.45,
    })]);
    expect(screen.getByText('Antonio Gonsalves')).toBeInTheDocument();
  });

  it('shows the uncosted-freight hint only when an order actually shipped', () => {
    // V7: a pending/cancelled order has no freight to be missing, so the view
    // reports 0 and no amber hint appears next to $0.00 shipping.
    mount([row({ sale_shipping_cad: 0, shipping_uncosted_count: 0 })]);
    expect(screen.queryByText(/uncosted/)).not.toBeInTheDocument();

    cleanup();
    mount([row({ sale_shipping_cad: 0, shipping_uncosted_count: 1 })]);
    expect(screen.getByText(/1 uncosted/)).toBeInTheDocument();
  });

  it('shows return handling as one line with the split in its tooltip', () => {
    mount([row({
      returns_handled: 2, return_stocking_cad: 100, return_inspection_cad: 150,
      return_freight_cad: 191.82, return_handling_cad: 441.82,
    })]);
    const dt = screen.getAllByText('Return handling').find(el => el.tagName === 'DT')!;
    const title = dt.closest('div')!.getAttribute('title')!;
    expect(title).toContain('2 unit(s) came back');
    expect(title).toContain('stocking');
    expect(title).toContain('inspection');
  });

  it('flags return handling whose freight is not on file', () => {
    // 45 of 51 returns have no tracking, so freight is $0 and the total is a
    // floor, not the real cost. Say so rather than implying it is complete.
    mount([row({
      returns_handled: 1, return_stocking_cad: 50, return_inspection_cad: 75,
      return_freight_cad: 0, return_handling_cad: 125,
    })]);
    expect(screen.getByText(/freight missing/)).toBeInTheDocument();
  });

  it('excludes customer-discarded returns from return handling', () => {
    // A discarded unit never shipped, so returns_handled is 0 and no line shows.
    mount([row({ returns_handled: 0, return_handling_cad: 0 })]);
    expect(screen.queryAllByText('Return handling').filter(el => el.tagName === 'DT')).toHaveLength(0);
  });

  it('does not render a Support line for a customer who never called', () => {
    mount([row()]);
    expect(screen.queryByText('Support')).not.toBeInTheDocument();
  });
});
