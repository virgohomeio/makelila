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
    created_at: partial.created_at ?? '2026-04-17T00:00:00Z',
    // Honour an explicit placed_at — the SLA rail is plotted from it.
    placed_at: partial.placed_at !== undefined ? partial.placed_at : '2026-04-19T00:00:00Z',
  };
}

// Filtering, bucketing and sorting moved to filters.ts when the page took
// ownership of them (see filters.test.ts). What is left here is what the list
// itself is responsible for: rendering rows against the shared SLA axis.
const NOW = Date.parse('2026-08-21T12:00:00Z');
const agoDays = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('Sidebar', () => {
  const fresh = mkOrder({
    id: 'p1', status: 'pending', customer_name: 'Alice Ames',
    order_ref: '#1001', placed_at: agoDays(1),
  });
  const late = mkOrder({
    id: 'p2', status: 'pending', customer_name: 'Bob Boxer',
    order_ref: '#1002', placed_at: agoDays(9),
  });
  const dead = mkOrder({
    id: 'c1', status: 'cancelled', customer_name: 'Gabriella Hottya',
    order_ref: '#1003', cancelled_at: '2026-08-13T15:03:17Z', cancelled_reason: 'Delays',
  });

  const render_ = (orders = [fresh, late], selectedId: string | null = null, onSelect = vi.fn()) =>
    render(
      <Sidebar
        orders={orders}
        now={NOW}
        selectedId={selectedId}
        onSelect={onSelect}
        emptyHint="Nothing in this queue."
      />,
    );

  it('renders every order it is given, in the order given', () => {
    render_();
    const names = screen.getAllByRole('button').map(b => b.textContent);
    expect(names[0]).toContain('Alice Ames');
    expect(names[1]).toContain('Bob Boxer');
  });

  it('draws the shared SLA axis once, above the list', () => {
    render_();
    // The ticks the rails are plotted against — see sla.ts SLA_TICKS.
    for (const tick of ['today', '2d', '4d', '1w', '2w+']) {
      expect(screen.getByText(tick)).toBeInTheDocument();
    }
  });

  it('plots each row against that axis with a compact age label', () => {
    render_();
    expect(screen.getByText('1d')).toBeInTheDocument();
    expect(screen.getByText('9d')).toBeInTheDocument();
  });

  // An SLA countdown on a dead order is noise.
  it('marks a cancelled row as cancelled instead of plotting an SLA', () => {
    render_([dead]);
    const row = screen.getByRole('button', { name: /Gabriella Hottya/ });
    expect(row).toHaveTextContent(/cancelled/i);
    expect(row).not.toHaveTextContent(/\dd$/);
  });

  it('carries ref, city and country on the row', () => {
    render_();
    const row = screen.getByRole('button', { name: /Alice Ames/ });
    expect(row).toHaveTextContent('#1001');
    expect(row).toHaveTextContent('Portland');
    expect(row).toHaveTextContent('US');
  });

  it('reports how many orders it is showing', () => {
    render_();
    expect(screen.getByText('2 orders')).toBeInTheDocument();
    render_([fresh]);
    expect(screen.getByText('1 order')).toBeInTheDocument();
  });

  // The list cannot tell an empty queue from an over-narrow filter, so the
  // page tells it what to say.
  it('shows the hint it was given when there is nothing to show', () => {
    render(
      <Sidebar orders={[]} now={NOW} selectedId={null} onSelect={vi.fn()}
        emptyHint="No order matches these filters." />,
    );
    expect(screen.getByText('No order matches these filters.')).toBeInTheDocument();
  });

  it('invokes onSelect with the row id when a row is clicked', () => {
    const onSelect = vi.fn();
    render_([fresh, late], null, onSelect);
    fireEvent.click(screen.getByText('Alice Ames'));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });
});
