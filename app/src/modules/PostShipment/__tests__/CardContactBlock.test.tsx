// Every card on the Refunds board has to say how to reach the customer —
// email, phone and mailing address — not just the ones that already have a
// refund_approvals row behind them. A cancellation form (Gabriella Hottya,
// order #1209) and a return still in inspection are refund cases too, and an
// operator working them shouldn't have to leave for the Customers directory.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CancellationCard, ContactBlock, ReturnDetailModal } from '../RefundsTab';
import type { RefundParties } from '../../../lib/customers';
import type { OrderCancellation, ReturnRow } from '../../../lib/postShipment';

// These cards sit inside the authenticated app shell; nothing here is about
// who is signed in.
// Stable identities: these come back from hooks, and a fresh object on every
// render would spin any effect that depends on one.
const stub = vi.hoisted(() => ({
  auth: { user: null, profile: null, role: null, loading: false },
  notes: { notes: [], loading: false, refresh: () => {} },
  attachments: { attachments: [], loading: false, refresh: () => {} },
}));

vi.mock('../../../lib/auth', () => ({ useAuth: () => stub.auth }));

// Notes and attachments hit Supabase on mount; nothing here is about either.
vi.mock('../../../lib/postShipment', async (orig) => ({
  ...(await orig<typeof import('../../../lib/postShipment')>()),
  useCaseNotes: () => stub.notes,
  useCaseAttachments: () => stub.attachments,
}));

const parties: RefundParties = {
  purchaser: 'Gabriella Hottya',
  primaryUser: 'Gabriella Hottya',
  filer: 'Gabriella Hottya',
  samePerson: true,
  filerIsPurchaser: true,
  filerIsPrimaryUser: true,
};

const usage = { days: null, over30: null, onboardDate: null } as never;

const contact = {
  email: 'ghottya@yahoo.com',
  phone: '7864830997',
  address: '10350 W Bay Harbor Dr, Bay Harbor Is, FL, 33154, US',
};

const cancellation: OrderCancellation = {
  id: 'c1',
  order_ref: '#1209',
  customer_name: 'Gabriella Hottya',
  customer_email: 'ghottya@yahoo.com',
  customer_phone: '7864830997',
  preferred_contact: null,
  order_date: '2026-07-24',
  product_name: null,
  order_amount_usd: 799.99,
  purchase_channel: 'Shopify',
  reason: 'Delay — customer wanted the unit ASAP.',
  description: null,
  product_received: false,
  desired_resolution: null,
  status: 'submitted',
  ops_notes: null,
  processed_by: null,
  processed_at: null,
  refund_approval_id: null,
  created_at: '2026-08-13T15:03:17Z',
  updated_at: '2026-08-13T15:03:17Z',
};

const returnRow = {
  id: 'r1',
  return_ref: 'R-0099',
  customer_name: 'Gabriella Hottya',
  customer_email: 'ghottya@yahoo.com',
  customer_phone: '7864830997',
  original_order_ref: '#1209',
  status: 'created',
  return_reasons: [],
  source: 'customer_form',
  created_at: '2026-08-13T15:03:17Z',
  updated_at: '2026-08-13T15:03:17Z',
} as unknown as ReturnRow;

const noop = () => {};

describe('ContactBlock', () => {
  it('renders email, phone and address as reachable values', () => {
    render(<ContactBlock contact={contact} />);
    expect(screen.getByText('ghottya@yahoo.com').getAttribute('href')).toBe('mailto:ghottya@yahoo.com');
    expect(screen.getByText('7864830997').getAttribute('href')).toBe('tel:7864830997');
    expect(screen.getByText(contact.address)).toBeTruthy();
  });

  it('says which field is missing rather than rendering a blank line', () => {
    render(<ContactBlock contact={{ email: null, phone: null, address: null }} />);
    expect(screen.getByText('No email on file')).toBeTruthy();
    expect(screen.getByText('No phone number on file')).toBeTruthy();
    expect(screen.getByText('No address on file')).toBeTruthy();
  });
});

describe('CancellationCard', () => {
  const renderCard = () => render(
    <CancellationCard
      c={cancellation}
      parties={parties}
      contact={contact}
      canOwn
      usage={usage}
      invoices={[]}
      tickets={[]}
      onOpenTicket={noop}
      onError={noop}
    />,
  );

  it('shows the contact block once the request is opened', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Full Refund Card' }));
    expect(screen.getByText('ghottya@yahoo.com')).toBeTruthy();
    expect(screen.getByText('7864830997')).toBeTruthy();
    expect(screen.getByText(contact.address)).toBeTruthy();
  });

  // Opening a card must not empty its column — the board is how an operator
  // sees what is queued, and a request that vanishes while it is being read
  // looks like it was already dealt with.
  it('leaves the card in its column while the request is open', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Full Refund Card' }));
    expect(screen.getByRole('button', { name: 'Open Full Refund Card' })).toBeTruthy();
  });

  it('puts the card back on its own when the request is closed', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Full Refund Card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('ghottya@yahoo.com')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Full Refund Card' })).toBeTruthy();
  });
});

describe('ReturnDetailModal', () => {
  it('shows the contact block instead of a cramped email · phone line', () => {
    render(
      <ReturnDetailModal
        r={returnRow}
        parties={parties}
        contact={contact}
        canOwn
        usage={usage}
        invoices={[]}
        tickets={[]}
        onOpenTicket={noop}
        onCompile={noop}
        onError={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('ghottya@yahoo.com')).toBeTruthy();
    expect(screen.getByText('7864830997')).toBeTruthy();
    expect(screen.getByText(contact.address)).toBeTruthy();
  });
});
