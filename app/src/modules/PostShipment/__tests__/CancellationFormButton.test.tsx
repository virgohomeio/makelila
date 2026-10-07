import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CancellationFormButton } from '../RefundsTab';
import type { OrderCancellation } from '../../../lib/postShipment';

// Only the fields CancellationFormAnswers reads — the row is wider than this
// test cares about, so the rest is deliberately absent.
const row = {
  id: 'cancel-1',
  order_ref: '#1208',
  customer_name: 'Dana Whitfield',
  customer_email: 'dana@example.com',
  customer_phone: '+15145550188',
  preferred_contact: 'email',
  order_date: '2026-08-04',
  product_name: 'LILA Composter',
  order_amount_usd: 1499,
  purchase_channel: 'Online Store',
  reason: 'Ordered by mistake',
  description: 'Bought two by accident and only need the one.',
  product_received: false,
  desired_resolution: 'Full refund',
  ops_notes: 'Customer reference: CCR-41822',
  created_at: '2026-08-14T15:04:00Z',
} as unknown as OrderCancellation;

describe('CancellationFormButton', () => {
  it('keeps the form answers hidden behind the button', () => {
    render(<CancellationFormButton c={row} />);
    expect(screen.getByRole('button', { name: /Open Cancellation Form/ })).toBeTruthy();
    expect(screen.queryByText('Ordered by mistake')).toBeNull();
  });

  it('opens the answers, titled with the order it belongs to', () => {
    render(<CancellationFormButton c={row} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Cancellation Form/ }));
    expect(screen.getByText(/Cancellation form · #1208/)).toBeTruthy();
    expect(screen.getByText('Ordered by mistake')).toBeTruthy();
    expect(screen.getByText('Full refund')).toBeTruthy();
    expect(screen.getByText('Bought two by accident and only need the one.')).toBeTruthy();
    expect(screen.getByText('$1,499')).toBeTruthy();
    expect(screen.getByText('Customer reference: CCR-41822')).toBeTruthy();
  });

  // false is a real answer here — "not received yet" is what makes this a
  // cancellation rather than a return — so it must not render as blank.
  it('spells out whether the customer already has the unit', () => {
    render(<CancellationFormButton c={row} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Cancellation Form/ }));
    expect(screen.getByText('Product received yet?')).toBeTruthy();
    expect(screen.getByText('No')).toBeTruthy();
  });

  it('closes again from the Close button', () => {
    render(<CancellationFormButton c={row} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Cancellation Form/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Ordered by mistake')).toBeNull();
  });
});
