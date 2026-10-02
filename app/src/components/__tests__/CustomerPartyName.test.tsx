// The one place a ticket's person is drawn. A household with a separate
// primary user must show BOTH names — naming only the user hides who the
// warranty and any refund actually belong to — but the overwhelmingly common
// case is one person, and that case must stay a plain unadorned name.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CustomerParties } from '../../lib/customers';
import { CustomerPartyName } from '../CustomerPartyName';

const parties = (over: Partial<CustomerParties> = {}): CustomerParties => ({
  displayName: 'Sarah Wu',
  purchaserName: 'Chad Wu',
  split: true,
  relationship: null,
  phone: null,
  email: null,
  ...over,
});

describe('CustomerPartyName — one person', () => {
  it('renders a plain name with no role labels', () => {
    render(<CustomerPartyName parties={parties({
      displayName: 'Chad Wu', purchaserName: 'Chad Wu', split: false,
    })} />);
    expect(screen.getByText('Chad Wu')).toBeTruthy();
    expect(screen.queryByText(/Purchaser/)).toBeNull();
    expect(screen.queryByText(/Primary user/)).toBeNull();
  });
});

describe('CustomerPartyName — split household', () => {
  it('headlines the primary user and still names the purchaser', () => {
    render(<CustomerPartyName parties={parties()} />);
    expect(screen.getByText('Sarah Wu')).toBeTruthy();
    expect(screen.getByText(/Primary user/)).toBeTruthy();
    expect(screen.getByText(/Chad Wu/)).toBeTruthy();
    expect(screen.getByText(/Purchaser/)).toBeTruthy();
  });

  it('shows the relationship alongside the primary-user label', () => {
    render(<CustomerPartyName parties={parties({ relationship: 'Spouse / partner' })} />);
    expect(screen.getByText(/Spouse \/ partner/)).toBeTruthy();
  });

  it('keeps both names on one line in the inline variant', () => {
    const { container } = render(<CustomerPartyName parties={parties()} variant="inline" />);
    // Dense rows (kanban cards, inbox tables) can't afford a second line, but
    // must not therefore drop the purchaser entirely.
    expect(container.textContent).toContain('Sarah Wu');
    expect(container.textContent).toContain('Chad Wu');
  });
});

describe('CustomerPartyName — nothing on file', () => {
  it('falls back to an em dash rather than rendering an empty cell', () => {
    render(<CustomerPartyName parties={parties({
      displayName: '', purchaserName: '', split: false,
    })} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

// The name is the same kind of thing in every row — a person's name — so it
// must not change weight depending on whether a household happens to have a
// separate primary user. Rendering the split case through `.name` (600) and
// the plain case through a bare span made split households look bold for no
// reason the operator could act on.
describe('CustomerPartyName — the name reads the same either way', () => {
  const nameEl = (c: HTMLElement) => c.querySelector('[data-party-name]');

  it('renders the name through one identical element whether or not it splits', () => {
    const { container: plain } = render(<CustomerPartyName parties={parties({
      displayName: 'Chad Wu', purchaserName: 'Chad Wu', split: false,
    })} />);
    const { container: split } = render(<CustomerPartyName parties={parties()} />);

    expect(nameEl(plain)).not.toBeNull();
    expect(nameEl(split)).not.toBeNull();
    expect(nameEl(split)!.className).toBe(nameEl(plain)!.className);
  });

  it('uses that same element in the inline variant too', () => {
    const { container: plain } = render(<CustomerPartyName variant="inline" parties={parties({
      displayName: 'Chad Wu', purchaserName: 'Chad Wu', split: false,
    })} />);
    const { container: split } = render(
      <CustomerPartyName variant="inline" parties={parties()} />);

    expect(nameEl(split)!.className).toBe(nameEl(plain)!.className);
  });

  it('never hard-codes a weight on the name, so it inherits its context', () => {
    const { container } = render(<CustomerPartyName parties={parties()} />);
    expect((nameEl(container) as HTMLElement).style.fontWeight).toBe('');
  });
});
