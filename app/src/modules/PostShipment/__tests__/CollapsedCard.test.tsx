import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsedCard } from '../RefundsTab';
import type { RefundParties } from '../../../lib/customers';

const bothRoles: RefundParties = {
  purchaser: 'Amanda Acker',
  primaryUser: 'Amanda Acker',
  filer: 'Amanda Acker',
  samePerson: true,
  filerIsPurchaser: true,
  filerIsPrimaryUser: true,
};

const giftedUnit: RefundParties = {
  purchaser: 'Robin Acker',
  primaryUser: 'Amanda Acker',
  filer: 'Amanda Acker',
  samePerson: false,
  filerIsPurchaser: false,
  filerIsPrimaryUser: true,
};

describe('CollapsedCard', () => {
  it('shows the party header, the order ref and the open button — nothing else', () => {
    render(
      <CollapsedCard borderColor="#805ad5" parties={bothRoles} orderRef="#1172" onOpen={() => {}} />,
    );
    expect(screen.getByText('Amanda Acker')).toBeTruthy();
    expect(screen.getByText('Purchaser & primary user')).toBeTruthy();
    expect(screen.getByText(/filled the form/)).toBeTruthy();
    expect(screen.getByText('#1172')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Full Refund Card' })).toBeTruthy();
  });

  it('still names both parties when the filer is not the buyer', () => {
    render(<CollapsedCard borderColor="#805ad5" parties={giftedUnit} onOpen={() => {}} />);
    expect(screen.getByText('Robin Acker')).toBeTruthy();
    expect(screen.getByText('Amanda Acker')).toBeTruthy();
    expect(screen.getByText('Purchaser')).toBeTruthy();
  });

  it('omits the ref line when the case has no order ref', () => {
    render(<CollapsedCard borderColor="#805ad5" parties={bothRoles} orderRef={null} onOpen={() => {}} />);
    expect(screen.queryByText(/^#/)).toBeNull();
  });

  it('opens the full card from the button (once — not twice via the card)', () => {
    const onOpen = vi.fn();
    render(<CollapsedCard borderColor="#805ad5" parties={bothRoles} orderRef="#1172" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Full Refund Card' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the full card when the card body is clicked', () => {
    const onOpen = vi.fn();
    render(<CollapsedCard borderColor="#805ad5" parties={bothRoles} orderRef="#1172" onOpen={onOpen} />);
    fireEvent.click(screen.getByText('#1172'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
