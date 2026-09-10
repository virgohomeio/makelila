import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Order } from '../../../../lib/orders';
import type { FreightQuote, QuoteRun } from '../../../../lib/freight';

const quotes: FreightQuote[] = [];
const fetchFreightcomQuoteRun = vi.fn();
const selectQuote = vi.fn();
const verifyAddress = vi.fn();

vi.mock('../../../../lib/freight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/freight')>()),
  useQuotes: () => ({ quotes, loading: false, refetch: vi.fn().mockResolvedValue(undefined) }),
  fetchFreightcomQuoteRun: (...args: unknown[]) => fetchFreightcomQuoteRun(...args),
  selectQuote: (...args: unknown[]) => selectQuote(...args),
}));
vi.mock('../../../../lib/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/orders')>()),
  verifyAddress: (...args: unknown[]) => verifyAddress(...args),
}));

import { PreConfirmChecks } from '../PreConfirmChecks';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', order_ref: '#1252', kind: 'sale', status: 'pending',
    customer_name: 'Rob Quirk', customer_email: 'rob@example.com', customer_phone: '+1-555-0100',
    address_line: '6 Quirk Dr', address_line2: null, city: 'Pottsville',
    region_state: 'PA', country: 'US', postal_code: '17901',
    address_verdict: 'house', address_verdict_source: 'sync-guess',
    address_verified_at: null, address_match: null,
    address_google_formatted: null, address_google_postal: null, address_customer_postal: null,
    area_type: null, area_type_source: 'auto',
    freight_estimate_usd: 0, freight_threshold_usd: 200,
    freight_estimate_source: 'manual', customer_paid_shipping_usd: 0,
    currency: 'USD', total_usd: 849.99, line_items: [],
    created_at: '2026-09-08T00:00:00Z', placed_at: '2026-09-08T00:00:00Z',
    ...overrides,
  } as Order;
}

/** An order whose address has been verified and whose freight has been quoted
 *  against it — the state in which the summary is allowed to appear. */
function checkedOrder(overrides: Partial<Order> = {}): Order {
  return makeOrder({
    address_verified_at: '2026-09-10T15:14:35Z',
    address_match: 'match',
    address_customer_postal: '17901',
    address_google_postal: '17901-8740',
    address_google_formatted: '6 Quirk Drive, Pottsville, PA 17901-8740, USA',
    address_verdict: 'house',
    address_verdict_source: 'model',
    area_type: 'suburban',
    area_type_source: 'verified',
    freight_estimate_usd: 136.24,
    freight_estimate_source: 'freightcom',
    ...overrides,
  });
}

function quote(over: Partial<FreightQuote> = {}): FreightQuote {
  return {
    id: 'q-1', order_id: 'ord-1', provider: 'freightcom',
    service_level: 'Canpar — Ground', rate_cad: 136.24, rate_usd: null,
    transit_days: 2, quoted_at: '2026-09-10T16:00:00Z', selected: true,
    raw: {
      surcharges: [
        { type: 'fuel', amount: { value: '948', currency: 'CAD' } },
        { type: 'residential-delivery', amount: { value: '240', currency: 'CAD' } },
      ],
    },
    ...over,
  };
}

function run(over: Partial<QuoteRun> = {}): QuoteRun {
  return {
    quotes: [quote({ selected: false })],
    quoted_postal: '17901',
    quoted_postal_source: 'customer',
    package_count: 1,
    unit_count: 1,
    address_verified_at: '2026-09-10T15:14:35Z',
    ...over,
  };
}

describe('PreConfirmChecks', () => {
  beforeEach(() => {
    quotes.length = 0;
    verifyAddress.mockReset().mockResolvedValue({});
    fetchFreightcomQuoteRun.mockReset().mockResolvedValue(run());
    selectQuote.mockReset().mockResolvedValue(undefined);
  });

  // The order of operations is the point of the panel: a rate is only as
  // accurate as the postal code it was asked about.
  it('will not quote freight until the address has been verified', () => {
    render(<PreConfirmChecks order={makeOrder()} />);
    expect(screen.getByRole('button', { name: /1 · verify address/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /2 · get freight estimate/i })).toBeDisabled();
    expect(screen.getByText(/verify the address first/i)).toBeInTheDocument();
  });

  it('opens step 2 once the address is verified', () => {
    render(<PreConfirmChecks order={makeOrder({ address_verified_at: '2026-09-10T15:14:35Z' })} />);
    expect(screen.getByRole('button', { name: /2 · get freight estimate/i })).toBeEnabled();
  });

  it('runs the verify step against this order', async () => {
    render(<PreConfirmChecks order={makeOrder()} />);
    fireEvent.click(screen.getByRole('button', { name: /1 · verify address/i }));
    await waitFor(() => expect(verifyAddress).toHaveBeenCalledWith('ord-1'));
  });

  it('adopts the cheapest CAD rate when step 2 runs', async () => {
    render(<PreConfirmChecks order={makeOrder({ address_verified_at: '2026-09-10T15:14:35Z' })} />);
    fireEvent.click(screen.getByRole('button', { name: /2 · get freight estimate/i }));
    await waitFor(() => expect(selectQuote).toHaveBeenCalledWith('ord-1', 'q-1'));
  });

  it('says so plainly when the carrier returns no rate for the destination', async () => {
    fetchFreightcomQuoteRun.mockResolvedValue(run({ quotes: [] }));
    render(<PreConfirmChecks order={makeOrder({ address_verified_at: '2026-09-10T15:14:35Z' })} />);
    fireEvent.click(screen.getByRole('button', { name: /2 · get freight estimate/i }));
    await waitFor(() => expect(screen.getByText(/no carrier rates came back/i)).toBeInTheDocument());
    expect(selectQuote).not.toHaveBeenCalled();
  });

  // Half a summary reads as a finished picture of an address nobody finished
  // checking, so there isn't one until both checks have run.
  it('shows no summary until both checks have run', () => {
    const { rerender } = render(<PreConfirmChecks order={makeOrder()} />);
    expect(screen.getByText(/run both steps in order/i)).toBeInTheDocument();
    expect(screen.queryByText(/ships to/i)).not.toBeInTheDocument();

    rerender(<PreConfirmChecks order={makeOrder({ address_verified_at: '2026-09-10T15:14:35Z' })} />);
    expect(screen.getByText(/run step 2/i)).toBeInTheDocument();
    expect(screen.queryByText(/ships to/i)).not.toBeInTheDocument();
  });

  it('summarises the address, the code, the building, the area and the cost', () => {
    quotes.push(quote());
    render(<PreConfirmChecks order={checkedOrder()} />);

    expect(screen.getByText('6 Quirk Drive, Pottsville, PA 17901-8740, USA')).toBeInTheDocument();
    expect(screen.getByText('17901-8740')).toBeInTheDocument();
    expect(screen.getByText(/matches the postal authority/i)).toBeInTheDocument();
    expect(screen.getByText('House')).toBeInTheDocument();
    expect(screen.getByText('Suburban')).toBeInTheDocument();
    expect(screen.getByText('$136.24 CAD')).toBeInTheDocument();
    // The carrier's own itemisation is what says why this address costs this.
    expect(screen.getByText(/residential delivery \$2\.40 CAD/i)).toBeInTheDocument();
    expect(screen.getByText(/canpar — ground/i)).toBeInTheDocument();
  });

  // A model reading is the only building signal a Canadian address gets, and it
  // must never read as a postal-authority record.
  it('says where the building type came from', () => {
    quotes.push(quote());
    render(<PreConfirmChecks order={checkedOrder()} />);
    expect(screen.getByText(/read from the address by the classifier/i)).toBeInTheDocument();
  });

  it('shows the mismatch, not just the code, when the customer’s is wrong', () => {
    quotes.push(quote());
    render(<PreConfirmChecks order={checkedOrder({
      address_match: 'mismatch',
      address_customer_postal: '17902',
      address_google_postal: '17901',
    })} />);
    expect(screen.getByText('17902 → 17901')).toBeInTheDocument();
    expect(screen.getByText(/send the mismatch email/i)).toBeInTheDocument();
  });

  // Quoting the customer's own wrong code prices a place the parcel will never
  // go, so when the quote falls back to the verified one, it says so.
  it('reports when freight was quoted against the verified code', async () => {
    quotes.push(quote());
    fetchFreightcomQuoteRun.mockResolvedValue(run({
      quoted_postal: '17901', quoted_postal_source: 'verified',
    }));
    render(<PreConfirmChecks order={checkedOrder({
      address_match: 'mismatch', address_customer_postal: '17902', address_google_postal: '17901',
    })} />);
    fireEvent.click(screen.getByRole('button', { name: /freight estimated/i }));
    await waitFor(() => {
      expect(screen.getByText(/quoted against the postal authority’s zip code 17901/i)).toBeInTheDocument();
    });
  });
});
