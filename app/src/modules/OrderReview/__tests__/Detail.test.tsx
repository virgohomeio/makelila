import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { dispositionMock, needInfoMock, addOrderNoteMock, useOrderNotesMock, cancelOrderMock } = vi.hoisted(() => ({
  dispositionMock:  vi.fn(() => Promise.resolve()),
  needInfoMock:     vi.fn(() => Promise.resolve()),
  addOrderNoteMock: vi.fn(() => Promise.resolve()),
  useOrderNotesMock: vi.fn(() => ({ notes: [], loading: false })),
  cancelOrderMock:  vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    disposition:    dispositionMock,
    needInfo:       needInfoMock,
    addOrderNote:   addOrderNoteMock,
    useOrderNotes:  useOrderNotesMock,
    cancelOrder:    cancelOrderMock,
  };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    profile: { id: 'u1', display_name: 'Test User', role: 'member' },
    user: { id: 'u1', email: 'test@virgohome.io' },
    session: null,
    loading: false,
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { Detail } from '../Detail';
import type { Order } from '../../../lib/orders';

const order: Order = {
  id: 'order-1',
  order_ref: '#3847',
  status: 'pending',
  customer_name: 'Keith Taitano',
  customer_email: 'k@example.com',
  customer_phone: '+1-555-0100',
  quo_thread_url: null,
  address_line: '2847 SW Corbett',
  address_line2: null,
  city: 'Portland', region_state: 'OR', country: 'US',
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
  freight_estimate_usd: 89.5, freight_threshold_usd: 200,
  customer_paid_shipping_usd: 89.5, currency: 'USD',
  tracking_num: null, carrier: null,
  customer_id: null, awaiting_batch_id: null, replacement_state: null, held_reason: null,
  cancelled_at: null, cancelled_reason: null, freight_estimate_source: 'shopify',
  total_usd: 1149,
  subtotal_usd: null, tax_usd: null, discount_total_usd: null,
  discount_codes: null, payment_methods: null, financial_status: null, tax_lines: null, shipping_line_title: null,
  attribution_source: null, attribution_medium: null, attribution_campaign: null, attribution_referrer: null,
  attribution_last_source: null, attribution_last_medium: null, attribution_last_referrer: null,
  line_items: [{ sku: 'LL01', name: 'Lila 01', qty: 1, price_usd: 1149 }],
  sales_confirmed_fit: false,
  dispositioned_by: null, dispositioned_at: null,
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

describe('Detail', () => {
  beforeEach(() => {
    dispositionMock.mockClear();
    needInfoMock.mockClear();
    addOrderNoteMock.mockClear();
    cancelOrderMock.mockClear();
  });

  it('Confirm calls disposition with status=approved', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'approved');
    });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
  });

  it('Flag requires a reason before Submit is enabled', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^⚑ flag$/i }));
    const submit = screen.getByRole('button', { name: /^flag order$/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/being flagged/i), { target: { value: 'bad zip' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'flagged', 'bad zip');
    });
    expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'Flagged: bad zip');
  });

  it('Hold allows empty reason', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^⏸ hold$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^hold order$/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'held', '');
    });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
  });

  it('Need Info calls needInfo (not disposition)', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /need info/i }));
    fireEvent.change(screen.getByPlaceholderText(/what you need from the customer/i), { target: { value: 'driveway photo' } });
    fireEvent.click(screen.getByRole('button', { name: /^log request$/i }));
    await waitFor(() => {
      expect(needInfoMock).toHaveBeenCalledWith(order, 'driveway photo');
      expect(dispositionMock).not.toHaveBeenCalled();
    });
    expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'Need info: driveway photo');
  });

  // Cancelling is terminal — an order can be killed straight from Sales, but
  // never without a reason on the record, and never twice.
  it('Cancel requires a reason before Submit is enabled', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel order$/i }));
    const submit = screen.getByRole('button', { name: /^cancel this order$/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/being cancelled/i), { target: { value: 'customer changed their mind' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(cancelOrderMock).toHaveBeenCalledWith('order-1', 'customer changed their mind');
    });
    expect(dispositionMock).not.toHaveBeenCalled();
    expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'Cancelled: customer changed their mind');
  });

  it('shows a read-only cancelled bar instead of the actions once cancelled', () => {
    render(
      <Detail
        order={{
          ...order,
          status: 'cancelled',
          cancelled_at: '2026-08-13T15:03:17Z',
          cancelled_reason: 'Delays — customer wanted it ASAP',
        }}
        onAfterDisposition={vi.fn()}
      />,
    );
    expect(screen.getByText(/delays — customer wanted it asap/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel order$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^⚑ flag$/i })).not.toBeInTheDocument();
  });

  it('Add note button fires addOrderNote with the current user name + body', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/add a review note/i);
    fireEvent.change(textarea, { target: { value: 'first note' } });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    await waitFor(() => {
      expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'first note');
    });
  });

  // The action bar used to be REPLACED by the reason input, so opening a
  // drawer took the order's identity and the primary action off screen.
  it('keeps the action bar visible while a reason drawer is open', () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^⚑ flag$/i }));
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel order$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^flag order$/i })).toBeInTheDocument();
  });

  // There are two confirm criteria. The action bar claimed three for months
  // after the freight check was dropped; CRITERIA_COUNT now feeds both.
  it('names the real blockers and offers a jump to where each is fixed', () => {
    render(
      <Detail
        order={{ ...order, customer_phone: null, address_verdict: 'condo' }}
        onAfterDisposition={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 blockers before you can confirm/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 2 met/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix in customer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix in address/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeDisabled();
  });

  it('reports readiness instead of blockers once both criteria are met', () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    expect(screen.getByText(/ready to confirm/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix in/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeEnabled();
  });
});
