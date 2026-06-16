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
    freight_estimate_source: 'shopify',
    currency: 'USD',
    total_usd: 1149,
    subtotal_usd: null, tax_usd: null, discount_total_usd: null,
    discount_codes: null, payment_methods: null, financial_status: null,
    line_items: [],
    sales_confirmed_fit: false,
    dispositioned_by: null,
    dispositioned_at: null,
    kind: 'sale',
    linked_ticket_id: null,
    cogs_usd: null,
    shipping_cost_usd: null,
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

  const render_ = (selectedId: string | null = null, onSelect = vi.fn()) =>
    render(
      <Sidebar
        all={[p1, p2, h1, f1]}
        pending={[p1, p2]}
        held={[h1]}
        flagged={[f1]}
        approved={[]}
        replacement={[]}
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
    fireEvent.click(screen.getByText(/Flagged \(1\)/));
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
        all={[]} pending={[]} held={[]} flagged={[]} approved={[]} replacement={[]}
        selectedId={null} onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/no orders in this tab/i)).toBeInTheDocument();
  });
});
