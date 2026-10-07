// Recording arrivals is batch work: an operator walks the Shipped rail and
// confirms a morning's worth of boxes one after another. So the thing that has
// to hold is not "one card records one arrival" — QueueHeader.test covers that
// — but that card N+1 says nothing about card N. This drives the real board:
// the sidebar, the rails, the header and the re-read between them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  ROW_A, ROW_B, state, deliveredMock, resetOrders,
} = vi.hoisted(() => {
  const baseRow = {
    step: 6, assigned_serial: null, assigned_serials: [],
    test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
    carrier: 'Purolator', tracking_num: '520766148800', label_pdf_path: null,
    label_confirmed_at: null, label_confirmed_by: null,
    dock_printed: true, dock_affixed: true, dock_docked: true,
    dock_notified: true, dock_picked_up: true,
    dock_confirmed_at: null, dock_confirmed_by: null,
    starter_tracking_num: null, email_sent_at: '2026-09-24T16:19:32Z', email_sent_by: 'Reina',
    fulfilled_at: '2026-09-24T16:19:32Z', fulfilled_by: 'Reina',
    due_date: '2026-09-22', priority: false, created_at: '2026-06-29T00:00:00Z',
  };
  const baseOrder = {
    kind: 'sale', status: 'approved', country: 'CA',
    placed_at: '2026-06-29T00:00:00Z', created_at: '2026-06-29T00:00:00Z',
    line_items: [], awaiting_batch_id: null, linked_ticket_id: null,
    reconcile_outcome: null, customer_email: null, customer_phone: null,
    address_line: null, address_line2: null, postal_code: null,
  };
  // Held in a box rather than as a bare `let`: the mock factories below are
  // hoisted above every statement in this file, so they can only read state
  // that was created up here with them.
  const state: { orders: Record<string, unknown>[] } = { orders: [] };
  const resetOrders = () => {
    state.orders = [
      { ...baseOrder, id: 'o-1190', order_ref: '#1190', customer_name: 'Marlene Depeuter', city: 'Toronto', region_state: 'ON', delivered_at: null },
      { ...baseOrder, id: 'o-1203', order_ref: '#1203', customer_name: 'Charlotte Robinson', city: 'Victoria', region_state: 'BC', delivered_at: null },
    ];
  };
  resetOrders();
  return {
    // The two orders the real incident ran through, in the order they were worked.
    ROW_A: { ...baseRow, id: 'q-1190', order_id: 'o-1190' },
    ROW_B: { ...baseRow, id: 'q-1203', order_id: 'o-1203' },
    state,
    resetOrders,
    // Writes to the fixture the way the real one writes to the database, so the
    // board's re-read has something to find.
    deliveredMock: vi.fn(async (orderId: string, receivedOn?: string) => {
      const o = state.orders.find(x => x.id === orderId);
      if (o) o.delivered_at = `${receivedOn ?? '2026-10-07'}T16:00:00Z`;
    }),
  };
});

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ in: () => Promise.resolve({ data: state.orders, error: null }) }) }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  },
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    useFulfillmentQueue: () => ({
      ready: [], fulfilled: [ROW_A, ROW_B], loading: false, refresh: vi.fn(),
    }),
  };
});

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, markOrderDelivered: deliveredMock };
});

vi.mock('../../../lib/shippedOrders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/shippedOrders')>('../../../lib/shippedOrders');
  return {
    ...actual,
    useShippedEvidence: () => ({ evidence: null }),
    // Nothing in this fixture shipped outside the queue, and the real indexer
    // would need the whole evidence shape to say so.
    indexShippedQueueRows: () => new Map(),
  };
});

vi.mock('../../../lib/refundedOrders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/refundedOrders')>('../../../lib/refundedOrders');
  return { ...actual, useRefundMarks: () => ({ marks: null }), indexRefundFlags: () => new Map() };
});

vi.mock('../../../lib/pickupQueue', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/pickupQueue')>('../../../lib/pickupQueue');
  return { ...actual, useGoorooshipSends: () => ({ sends: new Map(), refresh: vi.fn() }) };
});

vi.mock('../../../lib/eztrans', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/eztrans')>('../../../lib/eztrans');
  return { ...actual, useEzTransRowIds: () => ({ ezTransRowIds: new Set<string>(), loading: false }) };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { email: 'huayi@virgohome.io' }, profile: { display_name: 'Huayi' }, loading: false }),
}));

// The step panels each open their own fetches and are not what this is about.
vi.mock('../queue/StepFulfilled', () => ({ StepFulfilled: () => null }));
vi.mock('../queue/GoorooshipDailyBatch', () => ({ GoorooshipDailyBatch: () => null }));

import Queue from '../queue/index';

const renderQueue = () => render(<MemoryRouter><Queue /></MemoryRouter>);
const shippedTab = () => screen.getByRole('button', { name: /^Shipped\b/ });
const openOrder = (name: string) => fireEvent.click(screen.getByText(name));
const receivedBtn = () => screen.queryByRole('button', { name: /^shipment received$/i });

beforeEach(() => {
  resetOrders();
  deliveredMock.mockClear();
});

describe('Fulfillment › Queue — walking the Shipped rail', () => {
  it('does not carry the arrival just recorded onto the next order opened', async () => {
    const { container } = renderQueue();
    const card = () => within(container.querySelector('section')!);
    fireEvent.click(shippedTab());
    await waitFor(() => expect(screen.getByText('Marlene Depeuter')).toBeTruthy());

    // Card 1: record the arrival.
    openOrder('Marlene Depeuter');
    fireEvent.click(receivedBtn()!);
    fireEvent.change(screen.getByLabelText(/date the shipment was received/i), {
      target: { value: '2026-09-24' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(screen.getByText(/Received: 9\/24\/2026/)).toBeTruthy());
    expect(deliveredMock).toHaveBeenCalledWith('o-1190', '2026-09-24');

    // Card 2: the next order down the rail. It was never received — #1203 is
    // the order that wore #1190's pill in production.
    fireEvent.click(shippedTab());
    openOrder('Charlotte Robinson');

    // The card is now #1203's, and it is owed an arrival rather than carrying
    // one: the button is back, which the stale pill used to take away.
    await waitFor(() => expect(card().getByText(/^#1203/)).toBeTruthy());
    expect(card().queryByText(/Received:/)).toBeNull();
    expect(card().queryByText(/recorded as received on/i)).toBeNull();
    expect(card().getByRole('button', { name: /^shipment received$/i })).toBeTruthy();
  });

  it('offers today for the next order, not the day typed for the last one', async () => {
    renderQueue();
    fireEvent.click(shippedTab());
    await waitFor(() => expect(screen.getByText('Marlene Depeuter')).toBeTruthy());

    openOrder('Marlene Depeuter');
    fireEvent.click(receivedBtn()!);
    fireEvent.change(screen.getByLabelText(/date the shipment was received/i), {
      target: { value: '2026-09-24' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(deliveredMock).toHaveBeenCalled());

    fireEvent.click(shippedTab());
    openOrder('Charlotte Robinson');
    fireEvent.click(receivedBtn()!);

    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(screen.getByLabelText(/date the shipment was received/i)).toHaveValue(expected);
  });

  // The rail is the other half of the claim: a confirmed order has to leave
  // Shipped, or the operator works it twice.
  it('moves the confirmed order out of Shipped and into Received', async () => {
    renderQueue();
    fireEvent.click(shippedTab());
    await waitFor(() => expect(screen.getByText('Marlene Depeuter')).toBeTruthy());

    openOrder('Marlene Depeuter');
    fireEvent.click(receivedBtn()!);
    fireEvent.click(screen.getByRole('button', { name: /record as received/i }));
    await waitFor(() => expect(deliveredMock).toHaveBeenCalled());

    fireEvent.click(shippedTab());
    const sidebar = screen.getByRole('complementary');
    await waitFor(() => expect(within(sidebar).queryByText('Marlene Depeuter')).toBeNull());
    expect(within(sidebar).getByText('Charlotte Robinson')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Received\b/ }));
    expect(within(sidebar).getByText('Marlene Depeuter')).toBeTruthy();
  });
});
