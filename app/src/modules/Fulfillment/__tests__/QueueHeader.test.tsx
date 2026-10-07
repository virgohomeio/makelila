// The two "this order leaves the queue" buttons that sit beside the Due pill.
// Both are destructive-ish, so the UI contract is: click opens a panel that
// spells out what will happen, cancelling needs a typed reason, and nothing
// fires until the operator confirms.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { cancelMock, flagMock, moveBackMock, rebookMock, deliveredMock } = vi.hoisted(() => ({
  deliveredMock: vi.fn(() => Promise.resolve()),
  cancelMock: vi.fn(() => Promise.resolve()),
  flagMock: vi.fn(() => Promise.resolve()),
  moveBackMock: vi.fn(() => Promise.resolve({
    status: 'pending', replacement_state: null, label: 'Order Review › Pending',
  })),
  rebookMock: vi.fn(() => Promise.resolve({
    order_ref: 'R-0002',
    previous: { carrier: 'Canpar', tracking_num: 'D420000112' },
    restored: ['00019'],
  })),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    cancelOrderFromQueue: cancelMock,
    flagOrderFromQueue: flagMock,
    returnQueueRowToOrders: moveBackMock,
    setQueuePriority: vi.fn(() => Promise.resolve()),
    goBackStep: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, markOrderDelivered: deliveredMock };
});

vi.mock('../../../lib/rebookShipment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/rebookShipment')>('../../../lib/rebookShipment');
  return { ...actual, rebookShipment: rebookMock };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'reina@virgohome.io' },
    profile: { display_name: 'Reina' },
    loading: false,
  }),
}));

import { QueueHeader } from '../queue/QueueHeader';
import { goBackStep, type FulfillmentQueueRow } from '../../../lib/fulfillment';

const row = {
  id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: '00019', assigned_serials: ['00019'],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null, label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false,
  dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null,
  due_date: '2026-08-19', priority: false, created_at: '2026-06-05T00:00:00Z',
} as FulfillmentQueueRow;

const order = {
  order_ref: 'R-0002', customer_name: 'Jake Wenger', city: 'Grand Rapids',
  region_state: 'MN', country: 'US' as const,
  placed_at: '2026-06-05T00:00:00Z', created_at: '2026-06-05T00:00:00Z',
};

beforeEach(() => {
  cancelMock.mockClear(); flagMock.mockClear();
  moveBackMock.mockClear(); rebookMock.mockClear(); deliveredMock.mockClear();
});

// The third exit, between cancelling and postponing: the order is stopped and
// handed to Sales to answer something about, with the note the packer typed.
describe('Flag Order', () => {
  it('sits beside Cancel Order on an open order', () => {
    render(<QueueHeader row={row} order={order} />);
    expect(screen.getByRole('button', { name: /^flag order$/i })).toBeTruthy();
  });

  // The one action offered on every order in the queue. The other two exits are
  // about getting a box back on the shelf, which is meaningless once it has
  // gone — raising a problem with the order is not.
  it('is still offered once the order has shipped, when the other exits are not', () => {
    const shipped = { ...row, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' } as FulfillmentQueueRow;
    render(<QueueHeader row={shipped} order={order} />);
    expect(screen.getByRole('button', { name: /^flag order$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^cancel order$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /shipment not ready/i })).toBeNull();
  });

  it('promises a shipped order nothing will move', () => {
    const shipped = { ...row, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' } as FulfillmentQueueRow;
    render(<QueueHeader row={shipped} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByText(/still reads as shipped/)).toBeTruthy();
    expect(screen.getByText(/stays with the customer/)).toBeTruthy();
    expect(screen.queryByText(/removed from the fulfillment queue/)).toBeNull();
  });

  // The row survives EVERY flag, so announcing it through onRemoved would
  // deselect the order and claim a removal that never happened.
  it('keeps a flagged shipped order on screen and says so in place', async () => {
    const shipped = { ...row, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' } as FulfillmentQueueRow;
    const onRemoved = vi.fn();
    const onStepChanged = vi.fn();
    render(
      <QueueHeader row={shipped} order={order} onRemoved={onRemoved} onStepChanged={onStepChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'arrived cracked' } });
    fireEvent.click(screen.getByRole('button', { name: /flag this order/i }));

    await waitFor(() => {
      expect(flagMock).toHaveBeenCalledWith('q-1', 'arrived cracked', 'Reina');
      expect(screen.getByText(/is flagged/)).toBeTruthy();
    });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onStepChanged).toHaveBeenCalled();
  });

  // Replacements were excluded until bucketOrders grew a keyhole for a flagged
  // one. They flag from the same button now.
  it('is offered on a replacement too', () => {
    render(<QueueHeader row={row} order={{ ...order, kind: 'replacement' as const }} />);
    expect(screen.getByRole('button', { name: /^flag order$/i })).toBeTruthy();
  });

  it('tells a replacement’s operator it stays listed in Replacements', () => {
    render(<QueueHeader row={row} order={{ ...order, kind: 'replacement' as const }} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByText(/Service › Replacements/)).toBeTruthy();
    expect(screen.getByText(/clearing the flag in Sales/i)).toBeTruthy();
  });

  it('keeps the sale wording on a sale', () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.queryByText(/Service › Replacements/)).toBeNull();
    expect(screen.getByText(/confirming the order again/i)).toBeTruthy();
  });

  // The whole point of the 2026-10-07 change: a flag used to delete the queue
  // row, so the order the packer was holding vanished off the board. It stays,
  // badged, and the panel has to promise that before the operator commits.
  it('promises an un-shipped order it stays in the queue, badged', () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByText(/stays in this queue/i)).toBeTruthy();
    expect(screen.queryByText(/removed from the fulfillment queue/i)).toBeNull();
  });

  // Releasing the machine was part of pulling the row. With the row staying,
  // the pick stays with it — nothing goes back on the shelf for someone else.
  it('promises the assigned machine stays reserved', () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByText(/stays reserved for this order/i)).toBeTruthy();
    expect(screen.queryByText(/ready stock/i)).toBeNull();
  });

  it('says where the order is going before it goes, and asks first', () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByText(/Sales › Flagged/)).toBeTruthy();
    expect(flagMock).not.toHaveBeenCalled();
  });

  // The note is the whole feature: an order that stopped with no stated reason
  // is what this replaces.
  it('will not flag without a reason', () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    expect(screen.getByRole('button', { name: /flag this order/i }))
      .toHaveProperty('disabled', true);
  });

  // An un-shipped flag now behaves exactly like a shipped one: the order stays
  // selected, the confirmation is rendered in place, and the board re-reads so
  // the FLAGGED badge and the pause banner appear without the realtime socket.
  it('flags with the reason and the operator’s name, keeping the order on screen', async () => {
    const onRemoved = vi.fn();
    const onStepChanged = vi.fn();
    render(
      <QueueHeader row={row} order={order} onRemoved={onRemoved} onStepChanged={onStepChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Address is a PO box' } });
    fireEvent.click(screen.getByRole('button', { name: /flag this order/i }));

    await waitFor(() => {
      expect(flagMock).toHaveBeenCalledWith('q-1', 'Address is a PO box', 'Reina');
      expect(screen.getByText(/stays here in the queue/i)).toBeTruthy();
    });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onStepChanged).toHaveBeenCalled();
  });

  it('shows the error and keeps the pane open when the flag is refused', async () => {
    flagMock.mockRejectedValueOnce(new Error('A replacement cannot be flagged'));
    const onRemoved = vi.fn();
    render(<QueueHeader row={row} order={order} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: /^flag order$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /flag this order/i }));

    await waitFor(() => expect(screen.getByText(/A replacement cannot be flagged/)).toBeTruthy());
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

// The booking was made and then cancelled — the carrier was stood down, the
// pickup called off — and the whole shipment has to be booked again against the
// same order and the same machine.
describe('Rebook Shipment', () => {
  const booked = {
    ...row, step: 6, carrier: 'Canpar', tracking_num: 'D420000112',
    label_confirmed_at: '2026-10-01T12:00:00Z',
    email_sent_at: '2026-10-01T18:00:00Z', fulfilled_at: '2026-10-01T18:00:00Z',
  } as FulfillmentQueueRow;

  it('is offered on a shipped order — the one place the other two exits are not', () => {
    render(<QueueHeader row={booked} order={order} />);
    expect(screen.getByRole('button', { name: /rebook shipment/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^cancel order$/i })).toBeNull();
  });

  it('is not offered before a label exists', () => {
    render(<QueueHeader row={row} order={order} />);
    expect(screen.queryByRole('button', { name: /rebook shipment/i })).toBeNull();
  });

  it('names the booking that is about to be torn up, and asks first', () => {
    render(<QueueHeader row={booked} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /rebook shipment/i }));

    expect(screen.getByText(/Canpar · D420000112/)).toBeTruthy();
    expect(screen.getByText(/Ready to ship/)).toBeTruthy();
    expect(rebookMock).not.toHaveBeenCalled();
  });

  it('rebooks with the operator note and tells the board to re-read', async () => {
    const onStepChanged = vi.fn();
    render(<QueueHeader row={booked} order={order} onStepChanged={onStepChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /rebook shipment/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pickup cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: /rebook this shipment/i }));

    await waitFor(() => {
      expect(rebookMock).toHaveBeenCalledWith('q-1', 'pickup cancelled');
      expect(onStepChanged).toHaveBeenCalled();
    });
  });

  // Unlike Cancel Order, a note is a courtesy here: the row stays, and nothing
  // is lost by rebooking without one.
  it('does not demand a note', () => {
    render(<QueueHeader row={booked} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /rebook shipment/i }));
    expect(screen.getByRole('button', { name: /rebook this shipment/i }))
      .toHaveProperty('disabled', false);
  });
});

describe('QueueHeader exit actions', () => {
  it('offers both actions beside the Due pill on an open order', () => {
    render(<QueueHeader row={row} order={order} />);
    expect(screen.getByRole('button', { name: /^cancel order$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /shipment not ready/i })).toBeTruthy();
  });

  it('hides both once the order is fulfilled — that is a returns problem', () => {
    const shipped = { ...row, step: 6, fulfilled_at: '2026-06-20T00:00:00Z' } as FulfillmentQueueRow;
    render(<QueueHeader row={shipped} order={order} />);
    expect(screen.queryByRole('button', { name: /^cancel order$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /shipment not ready/i })).toBeNull();
  });

  it('will not cancel until a reason is typed', async () => {
    render(<QueueHeader row={row} order={order} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel order$/i }));

    const confirm = screen.getByRole('button', { name: /cancel this order/i });
    expect(confirm).toHaveProperty('disabled', true);
    expect(cancelMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'customer changed their mind' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel this order/i }));

    await waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith('q-1', 'customer changed their mind');
    });
  });

  it('moves back without a reason and reports where the order landed', async () => {
    const onRemoved = vi.fn();
    render(<QueueHeader row={row} order={order} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: /shipment not ready/i }));
    // The panel names the unit that is about to go back on the shelf.
    expect(screen.getByText(/00019 goes back into ready stock/i)).toBeTruthy();

    // Exact: the trigger button ("Shipment Not Ready — Move Back to Orders")
    // would also match a loose /move back to orders/i.
    fireEvent.click(screen.getByRole('button', { name: 'Move back to Orders' }));
    await waitFor(() => {
      expect(moveBackMock).toHaveBeenCalledWith('q-1', '');
      expect(onRemoved).toHaveBeenCalledWith(expect.stringContaining('Order Review › Pending'));
    });
  });

  it('surfaces a failure instead of pretending the order left the queue', async () => {
    const onRemoved = vi.fn();
    cancelMock.mockRejectedValueOnce(new Error('no permission'));
    render(<QueueHeader row={row} order={order} onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel order$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'duplicate order' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel this order/i }));

    await waitFor(() => expect(screen.getByText(/no permission/i)).toBeTruthy());
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

// The "← Back" rewind. Reported from prod on 2026-09-10: an operator could not
// walk order #1252 back a step. Two separate causes met here — the board went
// stale (covered in lib/fulfillment.queueRefresh.test.ts) and a fulfilled order
// could only be rewound by one hardcoded email address. Every order has to be
// able to go back to the previous step, whoever is holding the mouse.
describe('QueueHeader step rewind', () => {
  // Exact: /back/i would also catch "Move Back to Orders".
  const backBtn = () => screen.getByRole('button', { name: '← Back' });

  beforeEach(() => {
    vi.mocked(goBackStep).mockClear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('is disabled at step 1 — there is no earlier step to go to', () => {
    render(<QueueHeader row={row} order={order} />);
    expect(backBtn()).toHaveProperty('disabled', true);
    expect(backBtn().getAttribute('title')).toMatch(/no previous step/i);
  });

  it('rewinds a mid-queue step for any operator', async () => {
    const atDock = { ...row, step: 4 } as FulfillmentQueueRow;
    render(<QueueHeader row={atDock} order={order} />);
    expect(backBtn()).toHaveProperty('disabled', false);
    fireEvent.click(backBtn());
    await waitFor(() => expect(goBackStep).toHaveBeenCalledWith('q-1', 4));
  });

  // reina@virgohome.io is the mocked operator above and is not an admin.
  it('rewinds a fulfilled order for a non-admin operator too', async () => {
    const shipped = {
      ...row, step: 6, fulfilled_at: '2026-09-08T00:00:00Z',
      email_sent_at: '2026-09-08T00:00:00Z',
    } as FulfillmentQueueRow;
    render(<QueueHeader row={shipped} order={order} />);
    expect(backBtn()).toHaveProperty('disabled', false);
    fireEvent.click(backBtn());
    await waitFor(() => expect(goBackStep).toHaveBeenCalledWith('q-1', 6));
  });

  it('asks the board to re-read once the rewind is written', async () => {
    const onStepChanged = vi.fn();
    const atDock = { ...row, step: 4 } as FulfillmentQueueRow;
    render(<QueueHeader row={atDock} order={order} onStepChanged={onStepChanged} />);
    fireEvent.click(backBtn());
    await waitFor(() => expect(onStepChanged).toHaveBeenCalled());
  });

  it('leaves the board alone if the rewind failed', async () => {
    const onStepChanged = vi.fn();
    vi.mocked(goBackStep).mockRejectedValueOnce(new Error('rewind blocked'));
    const atDock = { ...row, step: 4 } as FulfillmentQueueRow;
    render(<QueueHeader row={atDock} order={order} onStepChanged={onStepChanged} />);
    fireEvent.click(backBtn());
    await waitFor(() => expect(screen.getByText(/rewind blocked/i)).toBeTruthy());
    expect(onStepChanged).not.toHaveBeenCalled();
  });
});

// The end of the line. A shipped order is not done — the customer still has to
// actually get the box — and the day they got it is what the warranty and the
// follow-up clocks count from, so it is asked for rather than stamped as now().
describe('Shipment Received', () => {
  const shippedRow = { ...row, step: 6, fulfilled_at: '2026-06-01T00:00:00Z' } as FulfillmentQueueRow;
  const shippedOrder = { ...order, id: 'o-1', delivered_at: null };
  const receivedBtn = () => screen.getByRole('button', { name: /^shipment received$/i });

  it('is not offered on an order that has not shipped', () => {
    render(<QueueHeader row={row} order={shippedOrder} />);
    expect(screen.queryByRole('button', { name: /^shipment received$/i })).toBeNull();
  });

  it('is offered at step 6', () => {
    render(<QueueHeader row={shippedRow} order={shippedOrder} />);
    expect(receivedBtn()).toBeTruthy();
  });

  // A shipment booked outside the queue never reaches step 6 — lib/shippedOrders
  // is what recognises those — and the customer still got a box.
  it('is offered on a row shipped some other way', () => {
    render(<QueueHeader row={row} order={shippedOrder} shipped />);
    expect(receivedBtn()).toBeTruthy();
  });

  it('records the day picked, not today', async () => {
    const onReceived = vi.fn();
    render(<QueueHeader row={shippedRow} order={shippedOrder} onReceived={onReceived} />);
    fireEvent.click(receivedBtn());
    fireEvent.change(screen.getByLabelText(/date the shipment was received/i), {
      target: { value: '2026-06-09' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(deliveredMock).toHaveBeenCalledWith('o-1', '2026-06-09'));
    // The orders behind the queue are read once, so the board has to be told.
    await waitFor(() => expect(onReceived).toHaveBeenCalled());
  });

  it('nothing is written until the operator confirms', () => {
    render(<QueueHeader row={shippedRow} order={shippedOrder} />);
    fireEvent.click(receivedBtn());
    expect(deliveredMock).not.toHaveBeenCalled();
  });

  it('says so in place afterwards — the row stays on screen', async () => {
    render(<QueueHeader row={shippedRow} order={shippedOrder} />);
    fireEvent.click(receivedBtn());
    fireEvent.change(screen.getByLabelText(/date the shipment was received/i), {
      target: { value: '2026-06-09' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(screen.getByText(/recorded as received on/i)).toBeTruthy());
    // Twice over, and both are wanted: the notice says what just happened, and
    // the pill beside the Fulfilled one is what the card reads as from now on.
    expect(screen.getAllByText(/6\/9\/2026/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Received: 6\/9\/2026/)).toBeTruthy();
  });

  it('shows the date instead of the button once it is on file', () => {
    render(<QueueHeader row={shippedRow} order={{ ...shippedOrder, delivered_at: '2026-06-09T12:00:00Z' }} />);
    expect(screen.queryByRole('button', { name: /^shipment received$/i })).toBeNull();
    expect(screen.getByText(/Received: 6\/9\/2026/)).toBeTruthy();
  });

  it('surfaces a rejected date instead of claiming it saved', async () => {
    deliveredMock.mockRejectedValueOnce(new Error('A shipment cannot be received in the future.'));
    const onReceived = vi.fn();
    render(<QueueHeader row={shippedRow} order={shippedOrder} onReceived={onReceived} />);
    fireEvent.click(receivedBtn());
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(screen.getByText(/cannot be received in the future/i)).toBeTruthy());
    expect(onReceived).not.toHaveBeenCalled();
  });

  it('warns that the ticket closes when the box is a replacement', () => {
    render(<QueueHeader
      row={shippedRow}
      order={{ ...shippedOrder, kind: 'replacement' as const, linked_ticket_id: 't-9' }}
    />);
    fireEvent.click(receivedBtn());
    expect(screen.getByText(/originating support ticket is/i)).toBeTruthy();
  });
});
