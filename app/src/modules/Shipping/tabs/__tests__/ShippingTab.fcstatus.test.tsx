import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShippingTab } from '../ShippingTab';

// jsdom doesn't implement navigation; stub reload (called after refresh).
Object.defineProperty(window, 'location', {
  value: { ...window.location, reload: vi.fn() },
  writable: true,
});

// Mock the data layer so the component renders deterministic rows, while
// keeping the real FREIGHTCOM_STATUSES / displayFreightcomStatus / isKnown*.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../../lib/shipping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/shipping')>();
  return {
    ...actual,
    useShippingOrders: () => ({ orders: [], loading: false }),
    useAllShipments: () => ({
      loading: false,
      error: null,
      shipments: [
        { id: 's1', order_id: 'o1', order_ref: '#1134', customer_name: 'Jeff',
          carrier: 'FedEx', service: 'Ground', rate_cad: 20, primary_tracking_number: '77',
          status: 'booked', booked_at: '2026-06-01T00:00:00Z', label_url: null,
          freightcom_shipment_id: 'fc1', freightcom_status: 'in-transit', status_synced_at: '2026-06-02T00:00:00Z',
          direction: 'outbound', counterparty_name: 'Esmeralda Burgess' },
        { id: 's2', order_id: 'o2', order_ref: '#1140', customer_name: 'Ann',
          carrier: 'Purolator', service: 'Express', rate_cad: 30, primary_tracking_number: '88',
          status: 'booked', booked_at: '2026-06-01T00:00:00Z', label_url: null,
          freightcom_shipment_id: 'fc2', freightcom_status: 'out-for-delivery', status_synced_at: null,
          direction: 'return', counterparty_name: 'Brent Neave' },
      ],
    }),
    refreshFreightcomStatuses: refreshMock,
  };
});

// useQuotes lives in lib/freight — mock it so the Book-a-Label section is inert.
vi.mock('../../../../lib/freight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/freight')>();
  return { ...actual, useQuotes: () => ({ quotes: [], loading: false }) };
});

beforeEach(() => refreshMock.mockClear());

describe('ShippingTab — Freightcom statuses', () => {
  it('renders Freightcom status labels (known + unknown verbatim)', () => {
    render(<ShippingTab />);
    expect(screen.getByText('in-transit')).toBeTruthy();
    expect(screen.getByText('out-for-delivery')).toBeTruthy(); // unknown shown verbatim
  });

  it('groups unknown statuses under the "Other" filter', () => {
    render(<ShippingTab />);
    fireEvent.click(screen.getByText(/^Other/));
    expect(screen.getByText('out-for-delivery')).toBeTruthy();
    expect(screen.queryByText('in-transit')).toBeNull();
  });

  it('calls refreshFreightcomStatuses when the refresh button is clicked', () => {
    render(<ShippingTab />);
    fireEvent.click(screen.getByText(/Refresh from Freightcom/));
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it('shows the counterparty name as the Customer for every row', () => {
    render(<ShippingTab />);
    expect(screen.getByText('Esmeralda Burgess')).toBeTruthy(); // outbound recipient
    expect(screen.getByText('Brent Neave')).toBeTruthy();       // return sender
  });

  it('marks returns and filters to them via the Returns chip', () => {
    render(<ShippingTab />);
    expect(screen.getByText('↩ Return')).toBeTruthy();
    fireEvent.click(screen.getByText(/Returns/));
    expect(screen.getByText('Brent Neave')).toBeTruthy();       // the return row stays
    expect(screen.queryByText('Esmeralda Burgess')).toBeNull(); // outbound filtered out
  });
});
