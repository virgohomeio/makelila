import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const {
  useReconcileQueueMock, recordShippedOfflineMock, recordDuplicateMock, recordStillOpenMock,
} = vi.hoisted(() => ({
  useReconcileQueueMock: vi.fn(),
  recordShippedOfflineMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  recordDuplicateMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  recordStillOpenMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('../../../lib/reconcile', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/reconcile')>('../../../lib/reconcile');
  return {
    ...actual,
    useReconcileQueue: useReconcileQueueMock,
    recordShippedOffline: recordShippedOfflineMock,
    recordDuplicate: recordDuplicateMock,
    recordStillOpen: recordStillOpenMock,
  };
});

import Reconcile from '../Reconcile';
import type { ReconcileGroup } from '../../../lib/reconcile';

const order = (ref: string, placed: string) => ({
  id: `id-${ref}`, order_ref: ref, customer_id: 'c1', customer_name: 'Jane Doe',
  customer_email: 'jane@example.com', city: 'Toronto', region_state: 'ON', country: 'CA',
  total_usd: 999, currency: 'CAD', placed_at: placed, created_at: placed,
});

const unit = {
  serial: 'LL01-7', customer_id: 'c1', customer_name: 'Jane Doe',
  shipped_at: '2026-01-20T00:00:00Z', customer_order_ref: null,
  carrier: 'Freightcom', tracking_num: 'TRK1',
};

/** One customer, two orders, one machine — the shape the whole screen exists
 *  for. #1036 is proposed as the shipment, #1016 as its duplicate. */
const group: ReconcileGroup = {
  key: 'c1',
  customerName: 'Jane Doe',
  units: [unit],
  items: [
    {
      order: order('#1016', '2025-12-13'),
      suggestion: { kind: 'duplicate', ofOrderRef: '#1036', why: 'Every unit this customer has is accounted for by #1036' },
      candidates: [unit],
    },
    {
      order: order('#1036', '2026-01-16'),
      suggestion: { kind: 'shipped', serial: 'LL01-7', shippedAt: unit.shipped_at, confidence: 'high', why: 'Unit LL01-7 shipped 4 days after this order' },
      candidates: [unit],
    },
  ],
};

function mockQueue(groups: ReconcileGroup[], over: Partial<{ loading: boolean; error: string | null }> = {}) {
  useReconcileQueueMock.mockReturnValue({
    groups, loading: false, error: null, refetch: vi.fn(() => Promise.resolve()), ...over,
  });
}

describe('Reconcile', () => {
  beforeEach(() => {
    recordShippedOfflineMock.mockClear();
    recordDuplicateMock.mockClear();
    recordStillOpenMock.mockClear();
    useReconcileQueueMock.mockReset();
  });

  it('lists each order under its customer with the machines on file', () => {
    mockQueue([group]);
    render(<Reconcile />);
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('#1016')).toBeTruthy();
    expect(screen.getByText('#1036')).toBeTruthy();
    // The serial shows on the customer's unit chip and again in each row's picker.
    expect(screen.getAllByText(/LL01-7/).length).toBeGreaterThan(0);
    // "2" and "to review" are separate nodes so the figure can carry the data face.
    expect(screen.getByText('to review', { exact: false }).textContent).toContain('2');
  });

  it('records a shipment against the chosen serial in one click', async () => {
    mockQueue([group]);
    render(<Reconcile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Shipped' })[1]);
    await waitFor(() => expect(recordShippedOfflineMock).toHaveBeenCalledTimes(1));
    expect(recordShippedOfflineMock.mock.calls[0][1]).toBe('LL01-7');
    expect(await screen.findByText('✓ Shipped · LL01-7')).toBeTruthy();
  });

  it('does not cancel a duplicate until it is confirmed', async () => {
    mockQueue([group]);
    render(<Reconcile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[0]);
    expect(recordDuplicateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Cancel #1016 as a duplicate of #1036\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(recordDuplicateMock).toHaveBeenCalledWith(
      expect.objectContaining({ order_ref: '#1016' }), '#1036',
    ));
  });

  it('backs out of a duplicate without touching the order', () => {
    mockQueue([group]);
    render(<Reconcile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(recordDuplicateMock).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Duplicate' }).length).toBe(2);
  });

  it('leaves an order open and says it is back in Sales', async () => {
    mockQueue([group]);
    render(<Reconcile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]);
    await waitFor(() => expect(recordStillOpenMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('↺ Back in Sales')).toBeTruthy();
  });

  it('surfaces a write failure on the row instead of claiming success', async () => {
    mockQueue([group]);
    recordShippedOfflineMock.mockRejectedValueOnce(new Error('RLS denied'));
    render(<Reconcile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Shipped' })[1]);
    expect(await screen.findByText('RLS denied')).toBeTruthy();
  });

  it('names the missing migration when the columns are not there yet', () => {
    mockQueue([], { error: 'column orders.reconcile_outcome does not exist' });
    render(<Reconcile />);
    expect(screen.getByText(/20260828120000_order_reconciliation migration/)).toBeTruthy();
  });

  it('has nothing to say when the queue is empty', () => {
    mockQueue([]);
    render(<Reconcile />);
    expect(screen.getByText('Nothing to reconcile')).toBeTruthy();
  });

  it('offers no Duplicate button when the customer has only one order', () => {
    mockQueue([{ ...group, items: [group.items[1]] }]);
    render(<Reconcile />);
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Shipped' })).toBeTruthy();
  });
});
