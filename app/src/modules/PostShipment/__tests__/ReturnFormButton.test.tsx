import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReturnFormButton } from '../RefundsTab';
import type { ReturnRow } from '../../../lib/postShipment';

// Only the fields ReturnFormAnswers reads — the row is wider than this test
// cares about, so the rest is deliberately absent.
const row = {
  id: 'ret-1',
  return_ref: null,
  original_order_ref: '#1174',
  unit_serial: 'SNLL01-00000000312',
  channel: 'Canada',
  source: 'customer_form',
  usage_duration: 'Less than 1 week',
  condition: 'like-new',
  packaging_status: 'Yes — complete original packaging',
  alternative_composting: 'Other electric composter',
  refund_method_preference: 'Email (E-Transfer)',
  refund_contact: 'thajos@douglas.mcgill.ca',
  future_likelihood: 'Definitely Not',
  experience_rating: 2,
  return_reasons: ['Odor issues'],
  category_other: null,
  is_purchaser: true,
  support_contacted: "Yes — they tried to help but the issue wasn't resolved",
  description: 'Never got the device functioning since arrival.',
  would_change_decision: null,
  additional_comments: null,
} as unknown as ReturnRow;

describe('ReturnFormButton', () => {
  it('keeps the form answers hidden behind the button', () => {
    render(<ReturnFormButton r={row} />);
    expect(screen.getByRole('button', { name: 'Open Refund/Return Form' })).toBeTruthy();
    expect(screen.queryByText('SNLL01-00000000312')).toBeNull();
  });

  it('opens the answers, titled with the order it belongs to', () => {
    render(<ReturnFormButton r={row} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Refund/Return Form' }));
    expect(screen.getByText(/Refund\/Return form · #1174/)).toBeTruthy();
    expect(screen.getByText('SNLL01-00000000312')).toBeTruthy();
    expect(screen.getByText('Odor issues')).toBeTruthy();
    expect(screen.getByText('Never got the device functioning since arrival.')).toBeTruthy();
  });

  it('closes again from the Close button', () => {
    render(<ReturnFormButton r={row} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Refund/Return Form' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('SNLL01-00000000312')).toBeNull();
  });
});
