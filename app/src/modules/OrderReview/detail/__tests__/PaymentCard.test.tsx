import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PaymentCard } from '../PaymentCard';
import type { Order } from '../../../../lib/orders';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: 'ord-1',
    order_ref: '#1001',
    kind: 'sale',
    status: 'pending',
    customer_id: null,
    linked_ticket_id: null,
    awaiting_batch_id: null,
    replacement_state: null,
    cogs_usd: null,
    shipping_cost_usd: null,
    shipped_at: null,
    delivered_at: null,
    tracking_num: null,
    carrier: null,
    customer_name: 'Ron Russell',
    customer_email: 'ron@example.com',
    customer_phone: null,
    quo_thread_url: null,
    address_line: '123 Main St',
    address_line2: null,
    city: 'Ottawa',
    region_state: 'ON',
    country: 'CA',
    address_verdict: 'house',
    address_verified_at: null,
    address_match: null,
    address_google_formatted: null,
    address_google_postal: null,
    address_customer_postal: 'K1A 0A9',
    address_claude_verdict: null,
    address_claude_notes: null,
    address_claude_postal: null,
    freight_estimate_usd: 0,
    freight_threshold_usd: 100,
    customer_paid_shipping_usd: null,
    freight_estimate_source: 'shopify',
    currency: 'CAD',
    total_usd: 1396,
    subtotal_usd: null,
    tax_usd: null,
    discount_total_usd: null,
    discount_codes: null,
    payment_methods: null,
    financial_status: null,
    line_items: [],
    sales_confirmed_fit: false,
    dispositioned_by: null,
    dispositioned_at: null,
    created_at: '2026-01-01T00:00:00Z',
    placed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Order;
}

describe('PaymentCard', () => {
  it('renders full Shopify Payments breakdown', () => {
    const order = makeOrder({
      currency: 'CAD',
      total_usd: 1396,
      subtotal_usd: 1299,
      tax_usd: 97,
      discount_total_usd: 0,
      customer_paid_shipping_usd: 0,
      payment_methods: ['shopify_payments'],
      financial_status: 'paid',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('1,396');
    expect(container.textContent).toContain('Paid');
  });

  it('renders Sezzle partial payment with discount', () => {
    const order = makeOrder({
      currency: 'USD',
      total_usd: 1100,
      subtotal_usd: 1299,
      tax_usd: 0,
      discount_total_usd: 199,
      discount_codes: ['SAVE200'],
      payment_methods: ['sezzle'],
      financial_status: 'partially_paid',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('−');
    expect(container.textContent).toContain('SAVE200');
    expect(container.textContent).toContain('Partially paid');
  });

  it('renders refunded status and hides zero-discount row', () => {
    const order = makeOrder({
      currency: 'CAD',
      total_usd: 0,
      subtotal_usd: 1299,
      tax_usd: 0,
      discount_total_usd: null,
      payment_methods: ['shopify_payments'],
      financial_status: 'refunded',
    });
    const { container } = render(<PaymentCard order={order} />);
    expect(container).toMatchSnapshot();
    expect(container.textContent).toContain('Refunded');
    expect(container.textContent).not.toContain('Discount');
  });

  it('renders without crashing when all optional fields are null', () => {
    const order = makeOrder({
      subtotal_usd: null,
      tax_usd: null,
      discount_total_usd: null,
      payment_methods: null,
      financial_status: null,
    });
    expect(() => render(<PaymentCard order={order} />)).not.toThrow();
  });
});
