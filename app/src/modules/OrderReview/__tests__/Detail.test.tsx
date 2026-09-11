import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const {
  dispositionMock, needInfoMock, addOrderNoteMock, useOrderNotesMock, cancelOrderMock,
  releaseHoldMock,
} = vi.hoisted(() => ({
  dispositionMock:  vi.fn(() => Promise.resolve()),
  needInfoMock:     vi.fn(() => Promise.resolve()),
  addOrderNoteMock: vi.fn(() => Promise.resolve()),
  useOrderNotesMock: vi.fn(() => ({ notes: [], loading: false })),
  cancelOrderMock:  vi.fn(() => Promise.resolve()),
  releaseHoldMock:  vi.fn(() => Promise.resolve({
    landing: { status: 'pending', replacement_state: null, label: 'Order Review › Pending' },
    queueRowRemoved: true,
    releasedSerial: '00019',
  })),
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

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, releaseHold: releaseHoldMock };
});

// The pre-confirm panel subscribes to this order's quote history; the Detail
// tests are about the action bar and the blocker strip, so the hook is inert
// here and PreConfirmChecks has its own file.
vi.mock('../../../lib/freight', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/freight')>('../../../lib/freight');
  return {
    ...actual,
    useQuotes: () => ({ quotes: [], loading: false, refetch: vi.fn().mockResolvedValue(undefined) }),
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
    address_verdict_source: 'sync-guess',
    address_unit_status: null,
    address_area_type_error: null,
    address_validation_granularity: null,
    address_usps_dpv: null,
    address_usps_record_type: null,
    address_is_residential: null,
    address_is_business: null,
  area_type: 'suburban',
  area_type_source: 'auto',
  // The base fixture is an order that is ready to confirm: contact info on
  // file, a house, and both pre-ship checks run. Tests that are about a blocker
  // take one of those away.
  address_verified_at: '2026-09-10T15:14:35Z',
  address_match: 'match',
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
  cancelled_at: null, cancelled_reason: null, freight_estimate_source: 'freightcom',
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

  // A hold used to be a one-way door: the Held tab's only exit was Confirm,
  // which is gated on the pre-ship checks and ships the order. These cover the
  // way back out.
  describe('Release hold', () => {
    const heldOrder: Order = { ...order, status: 'held' };

    it('is offered only on a held order', () => {
      const { unmount } = render(<Detail order={order} onAfterDisposition={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /release hold/i })).toBeNull();
      unmount();

      render(<Detail order={heldOrder} onAfterDisposition={vi.fn()} />);
      expect(screen.getByRole('button', { name: /release hold/i })).toBeInTheDocument();
    });

    it('asks first, and does nothing if the confirm is discarded', () => {
      render(<Detail order={heldOrder} onAfterDisposition={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /▶ release hold/i }));
      expect(screen.getByText(/goes back to Pending for review/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
      expect(releaseHoldMock).not.toHaveBeenCalled();
    });

    it('releases the hold, notes it, and says the queue row went too', async () => {
      const onAfter = vi.fn();
      render(<Detail order={heldOrder} onAfterDisposition={onAfter} />);
      fireEvent.click(screen.getByRole('button', { name: /▶ release hold/i }));
      fireEvent.click(screen.getByRole('button', { name: /^release hold$/i }));

      await waitFor(() => {
        expect(releaseHoldMock).toHaveBeenCalledWith('order-1');
      });
      expect(addOrderNoteMock).toHaveBeenCalledWith(
        'order-1', 'Test User', 'Hold released: moved back to Pending for review',
      );
      // The banner names the second thing that happened: an operator who does
      // not know a queue row existed still needs to be told it is gone.
      expect(await screen.findByText(/fulfillment row was pulled/i)).toBeInTheDocument();
      expect(screen.getByText(/unit 00019 back to stock/i)).toBeInTheDocument();
      // Repairing THIS order is not queue work — the panel stays put.
      expect(onAfter).not.toHaveBeenCalled();
    });

    it('surfaces a refusal instead of pretending the hold lifted', async () => {
      releaseHoldMock.mockRejectedValueOnce(new Error('#1214 has already shipped'));
      render(<Detail order={heldOrder} onAfterDisposition={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /▶ release hold/i }));
      fireEvent.click(screen.getByRole('button', { name: /^release hold$/i }));

      expect(await screen.findByText(/already shipped/i)).toBeInTheDocument();
      expect(addOrderNoteMock).not.toHaveBeenCalled();
    });
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

  // Three confirm criteria since the pre-confirm panel landed: contact info,
  // address fit, and whether the two pre-ship checks were actually run. Every
  // count on the screen derives from CRITERIA_COUNT — the bar claimed three for
  // months after the freight check was dropped in June, when there were two.
  it('names the real blockers and offers a jump to where each is fixed', () => {
    render(
      <Detail
        order={{
          ...order,
          customer_phone: null,
          address_verdict: 'condo',
          address_verified_at: null,
          freight_estimate_source: 'shopify',
        }}
        onAfterDisposition={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 blockers before you can confirm/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 met/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix in customer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix in address/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run above/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeDisabled();
  });

  // A freight number seeded by Shopify is what the CUSTOMER paid for shipping,
  // not a carrier's rate for this address, so it does not clear the check.
  it('still blocks when the address is verified but nobody pulled a carrier rate', () => {
    render(
      <Detail
        order={{ ...order, freight_estimate_source: 'shopify' }}
        onAfterDisposition={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 blocker before you can confirm/i)).toBeInTheDocument();
    expect(screen.getByText(/no carrier rate has been pulled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeDisabled();
  });

  // The pane is a flex column that hides its overflow: .detailHead and the
  // blocker strip are flex: none, and .detailBody is the only part that
  // scrolls. A pre-ship panel pinned outside it grew with the summary until the
  // cards below had no height left and no way to be scrolled to — reported as
  // "can't see the rest of the sales card". Everything below the blocker strip
  // has to live inside the scrolling element.
  it('keeps the pre-ship checks inside the scrolling body, above the cards', () => {
    const { container } = render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    const body = container.querySelector('[class*="detailBody"]');
    const panel = container.querySelector('#order-review-precheck');
    expect(body).toBeTruthy();
    expect(panel).toBeTruthy();
    expect(body!.contains(panel!)).toBe(true);

    // …and the cards still follow it in the same scrolling column.
    expect(body!.textContent).toMatch(/Shipping Address/i);
    expect(body!.textContent).toMatch(/Freight Estimate/i);
    const groups = body!.querySelectorAll('[class*="group"]');
    expect(groups.length).toBeGreaterThan(0);
    expect(panel!.compareDocumentPosition(groups[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reports readiness instead of blockers once all three criteria are met', () => {
    render(
      <Detail order={order} onAfterDisposition={vi.fn()} />,
    );
    expect(screen.getByText(/ready to confirm/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix in/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeEnabled();
  });
});
