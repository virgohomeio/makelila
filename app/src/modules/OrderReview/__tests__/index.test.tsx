import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { useOrdersMock } = vi.hoisted(() => ({ useOrdersMock: vi.fn() }));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, useOrders: useOrdersMock, syncShopifyOrders: vi.fn() };
});
vi.mock('../../../lib/freight', () => ({ useQuotes: () => ({ quotes: [], loading: false }) }));
vi.mock('../../../lib/useMediaQuery', () => ({ useIsMobile: () => false }));
vi.mock('../../Templates', () => ({ default: () => <div>Templates view</div> }));
vi.mock('../../Upload', () => ({ default: () => <div>Upload view</div> }));

import OrderReview from '../index';
import type { Order } from '../../../lib/orders';

const NOW = Date.now();
const agoDays = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function mk(p: Partial<Order> & { id: string; status: Order['status'] }): Order {
  return {
    id: p.id, order_ref: p.order_ref ?? `#${p.id}`, status: p.status,
    customer_name: p.customer_name ?? 'Test User',
    customer_email: p.customer_email !== undefined ? p.customer_email : 'a@example.com',
    customer_phone: p.customer_phone !== undefined ? p.customer_phone : '+1-555-0100',
    quo_thread_url: null,
    address_line: p.address_line !== undefined ? p.address_line : '1 Way',
    address_line2: null, city: p.city ?? 'Portland', region_state: 'OR',
    country: p.country ?? 'US', address_verdict: p.address_verdict ?? 'house',
    area_type: p.area_type ?? 'suburban', area_type_source: 'auto',
    address_verified_at: null, address_match: null, address_google_formatted: null,
    address_google_postal: null, address_customer_postal: null, address_claude_verdict: null,
    address_claude_notes: null, address_claude_postal: null, address_confirmed_at: null,
    address_confirmation_sent_at: null,
    freight_estimate_usd: 89.5, freight_threshold_usd: 200,
    customer_paid_shipping_usd: 89.5, currency: 'USD',
    tracking_num: null, carrier: null, customer_id: null, awaiting_batch_id: null,
    replacement_state: null, held_reason: null, cancelled_at: null, cancelled_reason: null,
    freight_estimate_source: 'shopify', total_usd: 1149,
    subtotal_usd: null, tax_usd: null, discount_total_usd: null, discount_codes: null,
    payment_methods: null, financial_status: null, tax_lines: null, shipping_line_title: null,
    attribution_source: null, attribution_medium: null, attribution_campaign: null,
    attribution_referrer: null, attribution_last_source: null, attribution_last_medium: null,
    attribution_last_referrer: null, line_items: [],
    sales_confirmed_fit: false, dispositioned_by: null, dispositioned_at: null,
    kind: p.kind ?? 'sale', linked_ticket_id: null, cogs_usd: null,
    shipping_cost_usd: null, shipping_cost_currency: null, shipped_at: null, delivered_at: null,
    created_at: agoDays(1), placed_at: p.placed_at ?? agoDays(1),
  };
}

const ok      = mk({ id: 'a', status: 'pending', order_ref: '#1001', customer_name: 'Alice Ames' });
const blocked = mk({ id: 'b', status: 'pending', order_ref: '#1002', customer_name: 'Bob Boxer', customer_phone: null });
const late    = mk({ id: 'c', status: 'held',    order_ref: '#1003', customer_name: 'Cara Cole', placed_at: agoDays(11), country: 'CA' });
const dead    = mk({ id: 'd', status: 'cancelled', order_ref: '#1004', customer_name: 'Dana Diaz' });

function setup(orders: Order[] = [ok, blocked, late], cancelled: Order[] = [dead]) {
  useOrdersMock.mockReturnValue({
    all: orders, cancelled,
    pending: orders.filter(o => o.status === 'pending'),
    held: orders.filter(o => o.status === 'held'),
    flagged: [], approved: [], replacement: [], loading: false,
  });
  // useParams returns {} here, so no order is selected and Detail never
  // mounts — this exercises the page chrome, which is what is new.
  return render(<MemoryRouter><OrderReview /></MemoryRouter>);
}

describe('Sales page chrome', () => {
  it('summarises the queue in the page header', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.getByText(/in the queue/)).toBeInTheDocument();
  });

  it('draws a queue-bar segment per populated status, and a legend for all of them', () => {
    setup();
    const track = screen.getByRole('group', { name: /orders by status/i });
    expect(within(track).getByRole('button', { name: 'Pending: 2' })).toBeInTheDocument();
    expect(within(track).getByRole('button', { name: 'Held: 1' })).toBeInTheDocument();
    // Cancelled is terminal, so it gets no segment — but stays in the legend.
    expect(within(track).queryByRole('button', { name: /Cancelled/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancelled 1$/ })).toBeInTheDocument();
    // A status nothing holds is still reachable.
    expect(screen.getByRole('button', { name: /^Flagged 0$/ })).toBeInTheDocument();
  });

  it('filters the list from a queue-bar segment, and clears on a second press', () => {
    setup();
    const seg = screen.getByRole('button', { name: 'Held: 1' });
    fireEvent.click(seg);
    expect(screen.getByText('Cara Cole')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
    fireEvent.click(seg);
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
  });

  it('counts and applies the saved views', () => {
    setup();
    const blockedChip = screen.getByRole('button', { name: 'Blocked: 1 order' });
    fireEvent.click(blockedChip);
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Overdue 4 days+: 1 order' }));
    expect(screen.getByText('Cara Cole')).toBeInTheDocument();
    expect(screen.queryByText('Bob Boxer')).not.toBeInTheDocument();
  });

  // Status and saved view slice the same queue; picking one must release the
  // other rather than silently intersecting to nothing.
  it('releases the status filter when a saved view is picked', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Held: 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Blocked: 1 order' }));
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
  });

  it('searches, and offers to clear the filters it is applying', () => {
    setup();
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'cara' } });
    expect(screen.getByText('Cara Cole')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear 1 filter/i }));
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
  });

  it('filters by country from the toolbar', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Country/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Canada/ }));
    expect(screen.getByText('Cara Cole')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  it('says why the list is empty when filters are the reason', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No order matches these filters.')).toBeInTheDocument();
  });

  it('says the queue is empty when there is genuinely nothing', () => {
    setup([], []);
    expect(screen.getByText('Nothing in this queue.')).toBeInTheDocument();
    expect(screen.getByText('No live orders')).toBeInTheDocument();
  });

  it('switches to the Templates and Upload views', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    expect(screen.getByText('Templates view')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(screen.getByText('Upload view')).toBeInTheDocument();
  });
});
