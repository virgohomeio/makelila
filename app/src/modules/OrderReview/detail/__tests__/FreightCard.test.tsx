import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Order } from '../../../../lib/orders';
import type { FreightQuote } from '../../../../lib/freight';

const quotes: FreightQuote[] = [];
const fetchFreightcomQuotes = vi.fn();
const selectQuote = vi.fn();

vi.mock('../../../../lib/freight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/freight')>()),
  useQuotes: () => ({ quotes, loading: false, refetch: vi.fn().mockResolvedValue(undefined) }),
  fetchFreightcomQuotes: (...args: unknown[]) => fetchFreightcomQuotes(...args),
  selectQuote: (...args: unknown[]) => selectQuote(...args),
}));
vi.mock('../../../../lib/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/orders')>()),
  updateFreightEstimate: vi.fn().mockResolvedValue(undefined),
}));

import { FreightCard } from '../FreightCard';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', order_ref: '#1214', kind: 'sale', status: 'pending',
    customer_name: 'Ron Russell', customer_email: null, customer_phone: null,
    address_line: '1 Main St', address_line2: null, city: 'Ottawa',
    region_state: 'ON', country: 'CA', address_verdict: 'house',
    freight_estimate_usd: 0, freight_threshold_usd: 200,
    freight_estimate_source: 'manual', customer_paid_shipping_usd: 0,
    currency: 'CAD', total_usd: 1396, line_items: [],
    created_at: '2026-08-01T00:00:00Z', placed_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as Order;
}

function quote(over: Partial<FreightQuote> = {}): FreightQuote {
  return {
    id: 'q-1', order_id: 'ord-1', provider: 'freightcom',
    service_level: 'Purolator — Ground', rate_cad: 143.75, rate_usd: null,
    transit_days: 3, quoted_at: '2026-08-12T00:00:00Z', selected: false, raw: {},
    ...over,
  };
}

describe('FreightCard', () => {
  beforeEach(() => {
    quotes.length = 0;
    fetchFreightcomQuotes.mockReset().mockResolvedValue([]);
    selectQuote.mockReset().mockResolvedValue(undefined);
  });

  // The reported bug, at the surface the operator actually sees: Sales offered
  // no way to pull a carrier quote at all — only a link out to the ClickShip
  // portal and a box to retype the number into.
  it('offers a live carrier quote when there is none on file', async () => {
    render(<FreightCard order={makeOrder()} />);

    fireEvent.click(screen.getByRole('button', { name: /get live quote/i }));

    await waitFor(() => expect(fetchFreightcomQuotes).toHaveBeenCalledWith('ord-1'));
  });

  it('selects the cheapest returned quote so the estimate lands on the order', async () => {
    fetchFreightcomQuotes.mockResolvedValue([
      quote({ id: 'q-slow', rate_cad: 210.4 }),
      quote({ id: 'q-cheap', rate_cad: 143.75 }),
      quote({ id: 'q-usd', rate_cad: null, rate_usd: 90 }),
    ]);

    render(<FreightCard order={makeOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /get live quote/i }));

    await waitFor(() => expect(selectQuote).toHaveBeenCalledWith('ord-1', 'q-cheap'));
  });

  it('shows why the quote failed instead of failing silently', async () => {
    fetchFreightcomQuotes.mockRejectedValue(new Error('Order has no destination postal code'));

    render(<FreightCard order={makeOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /get live quote/i }));

    expect(await screen.findByText(/Order has no destination postal code/)).toBeInTheDocument();
  });

  it('still lets the operator paste a portal quote by hand', () => {
    render(<FreightCard order={makeOrder()} />);
    expect(screen.getByRole('button', { name: /paste clickship quote/i })).toBeInTheDocument();
  });
});
