import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import type { Order } from '../../../lib/orders';

function mkOrder(partial: Partial<Order> & { id: string; status: Order['status'] }): Order {
  return {
    id: partial.id,
    order_ref: partial.order_ref ?? `#${partial.id}`,
    status: partial.status,
    customer_name: partial.customer_name ?? 'Test User',
    customer_email: null,
    customer_phone: null,
    quo_thread_url: null,
    address_line: '1 Way',
    address_line2: null,
    city: 'Portland',
    region_state: 'OR',
    country: 'US',
    address_verdict: 'house',
    area_type: 'suburban',
    area_type_source: 'auto',
    address_verified_at: null,
    address_match: null,
    address_google_formatted: null,
    address_google_postal: null,
    address_customer_postal: null,
    address_claude_verdict: null,
    address_claude_notes: null,
    address_claude_postal: null,
    address_confirmed_at: null,
    address_confirmation_sent_at: null,
    freight_estimate_usd: 89.5,
    freight_threshold_usd: 200,
    customer_paid_shipping_usd: 89.5,
    tracking_num: null,
    carrier: null,
    customer_id: null,
    awaiting_batch_id: null,
    replacement_state: null,
    held_reason: null,
    cancelled_at: null,
    cancelled_reason: null,
    freight_estimate_source: 'shopify',
    currency: 'USD',
    total_usd: 1149,
    subtotal_usd: null, tax_usd: null, discount_total_usd: null,
    discount_codes: null, payment_methods: null, financial_status: null, tax_lines: null, shipping_line_title: null,
    attribution_source: null, attribution_medium: null, attribution_campaign: null, attribution_referrer: null,
    attribution_last_source: null, attribution_last_medium: null, attribution_last_referrer: null,
    line_items: [],
    sales_confirmed_fit: false,
    dispositioned_by: null,
    dispositioned_at: null,
    kind: 'sale',
    linked_ticket_id: null,
    cogs_usd: null,
    shipping_cost_usd: null,
    shipping_cost_currency: null,
    shipped_at: null,
    delivered_at: null,
    created_at: '2026-04-17T00:00:00Z',
    placed_at: '2026-04-19T00:00:00Z',
  };
}

describe('Sidebar', () => {
  const p1 = mkOrder({ id: 'p1', status: 'pending', customer_name: 'Alice Ames' });
  const p2 = mkOrder({ id: 'p2', status: 'pending', customer_name: 'Bob Boxer' });
  const h1 = mkOrder({ id: 'h1', status: 'held',    customer_name: 'Held Customer' });
  const f1 = mkOrder({ id: 'f1', status: 'flagged', customer_name: 'Flagged Customer' });
  const c1 = mkOrder({
    id: 'c1', status: 'cancelled', customer_name: 'Gabriella Hottya',
    cancelled_at: '2026-08-13T15:03:17Z', cancelled_reason: 'Delays',
  });

  const render_ = (selectedId: string | null = null, onSelect = vi.fn()) =>
    render(
      <Sidebar
        all={[p1, p2, h1, f1]}
        pending={[p1, p2]}
        held={[h1]}
        flagged={[f1]}
        approved={[]}
        replacement={[]}
        cancelled={[c1]}
        selectedId={selectedId}
        onSelect={onSelect}
      />,
    );

  it('shows only pending rows in the default tab', () => {
    render_();
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
    expect(screen.queryByText('Held Customer')).not.toBeInTheDocument();
    expect(screen.queryByText('Flagged Customer')).not.toBeInTheDocument();
  });

  it('switches tab content when a tab is clicked', () => {
    render_();
    fireEvent.click(screen.getByRole('button', { name: /^Flagged: 1 order$/ }));
    expect(screen.getByText('Flagged Customer')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  it('filters by search query within the active tab', () => {
    render_();
    const searchBox = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(searchBox, { target: { value: 'bob' } });
    expect(screen.getByText('Bob Boxer')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  it('invokes onSelect with the row id when a row is clicked', () => {
    const onSelect = vi.fn();
    render_(null, onSelect);
    fireEvent.click(screen.getByText('Alice Ames'));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('shows empty-state copy when the active tab has no rows', () => {
    render(
      <Sidebar
        all={[]} pending={[]} held={[]} flagged={[]} approved={[]} replacement={[]} cancelled={[]}
        selectedId={null} onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/nothing in pending/i)).toBeInTheDocument();
  });

  // Cancelled orders are dead but not gone: they get their own tab so the team
  // can still find one (and its reason) after the fact.
  it('keeps cancelled orders out of every live tab but lists them under Cancelled', () => {
    render_();
    expect(screen.queryByText('Gabriella Hottya')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled: 1 order$/ }));
    expect(screen.getByText('Gabriella Hottya')).toBeInTheDocument();
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
  });

  // Live tabs re-sort by order ref because they're a work queue. Cancelled is a
  // lookup list that arrives newest-first from bucketOrders, so the Sidebar must
  // leave it alone — sorting by ref here would bury the one just cancelled.
  it('renders the Cancelled tab in the order given, not by order ref', () => {
    const newer = mkOrder({
      id: 'c2', status: 'cancelled', customer_name: 'Newer Cancel', order_ref: '#9999',
      cancelled_at: '2026-08-13T00:00:00Z',
    });
    const older = mkOrder({
      id: 'c0', status: 'cancelled', customer_name: 'Older Cancel', order_ref: '#1001',
      cancelled_at: '2026-01-02T00:00:00Z',
    });
    render(
      <Sidebar
        all={[]} pending={[]} held={[]} flagged={[]} approved={[]} replacement={[]}
        cancelled={[newer, older]}
        selectedId={null} onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled: 2 orders$/ }));
    const names = screen.getAllByText(/Cancel$/).map(n => n.textContent);
    expect(names).toEqual(['Newer Cancel', 'Older Cancel']);
  });

  it('marks a cancelled row as cancelled instead of showing an SLA countdown', () => {
    render_();
    fireEvent.click(screen.getByRole('button', { name: /^Cancelled: 1 order$/ }));
    const row = screen.getByRole('button', { name: /Gabriella Hottya/ });
    expect(row).toHaveTextContent(/cancelled/i);
    expect(row).not.toHaveTextContent(/OVERDUE/);
  });

  // The rail is a scanning surface: identity on the left, state right-aligned
  // so tags and SLA chips form columns down the list. Rows are real buttons,
  // so the whole row is keyboard-reachable rather than a div with role.
  it('renders each order as a button carrying its ref, city and country', () => {
    render_();
    const row = screen.getByRole('button', { name: /Alice Ames/ });
    expect(row).toHaveTextContent('#p1');
    expect(row).toHaveTextContent('Portland');
    expect(row).toHaveTextContent('US');
  });

  it('reports how many orders the active tab is showing', () => {
    render_();
    expect(screen.getByText('2 orders')).toBeInTheDocument();
  });

  it('names the tab and the query when a search returns nothing', () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/search name/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/Nothing in Pending matches/i)).toBeInTheDocument();
    expect(screen.getByText('0 orders matching')).toBeInTheDocument();
  });

  it('clears the query from the search box', () => {
    render_();
    const box = screen.getByPlaceholderText(/search name/i);
    fireEvent.change(box, { target: { value: 'bob' } });
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
  });
});
