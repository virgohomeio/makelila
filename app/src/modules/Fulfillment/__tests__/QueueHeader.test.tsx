// The two "this order leaves the queue" buttons that sit beside the Due pill.
// Both are destructive-ish, so the UI contract is: click opens a panel that
// spells out what will happen, cancelling needs a typed reason, and nothing
// fires until the operator confirms.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { cancelMock, moveBackMock } = vi.hoisted(() => ({
  cancelMock: vi.fn(() => Promise.resolve()),
  moveBackMock: vi.fn(() => Promise.resolve({
    status: 'pending', replacement_state: null, label: 'Order Review › Pending',
  })),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    cancelOrderFromQueue: cancelMock,
    returnQueueRowToOrders: moveBackMock,
    setQueuePriority: vi.fn(() => Promise.resolve()),
    goBackStep: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'reina@virgohome.io' }, profile: null, loading: false }),
}));

import { QueueHeader } from '../queue/QueueHeader';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row = {
  id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: '00019',
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

beforeEach(() => { cancelMock.mockClear(); moveBackMock.mockClear(); });

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
