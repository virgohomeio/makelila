// The panel that stands in for Assign + Test on a parts-only replacement.
//
// Both of those steps are about a machine — pick one off the shelf, confirm its
// test report — so a replacement lid sent to the queue with "Ready to Ship"
// landed on the unit picker, the one action an operator holding a lid must not
// take. The row stuck at step 1 while the box went out anyway.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const markPartsShippedMock = vi.fn().mockResolvedValue({ order_ref: 'R-0062', ticket_marked_sent: true });
vi.mock('../../../lib/orders', () => ({
  markPartsReplacementShipped: (...args: unknown[]) => markPartsShippedMock(...(args as [])),
}));

import { StepPartsOnly } from '../queue/StepPartsOnly';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row = {
  id: 'q-1', order_id: 'o-62', step: 1,
  assigned_serial: null,
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null,
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null,
  email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null,
  due_date: null, priority: false, created_at: '2026-09-01T00:00:00Z',
} as FulfillmentQueueRow;

const order = {
  id: 'o-62', order_ref: 'R-0062', customer_name: 'Sam Reid',
  line_items: [
    { kind: 'part', part_id: 'P-LID-V36', sku: 'LILA-LID-V36', name: 'Top Lid', qty: 1, cost_per_unit_usd: 24, description: 'Replacement Top Lid (v3.6)' },
  ],
} as unknown as Parameters<typeof StepPartsOnly>[0]['order'];

const onShipped = vi.fn();

beforeEach(() => { vi.clearAllMocks(); });

describe('StepPartsOnly', () => {
  it('names what is in the box instead of offering a unit picker', () => {
    render(<StepPartsOnly row={row} order={order} onShipped={onShipped} />);
    expect(screen.getByText(/no machine to assign/i)).toBeInTheDocument();
    expect(screen.getByText('Replacement Top Lid (v3.6)')).toBeInTheDocument();
    expect(screen.getByText(/Sam Reid/)).toBeInTheDocument();
  });

  it('records the shipment, with the carrier and tracking when there are any', async () => {
    render(<StepPartsOnly row={row} order={order} onShipped={onShipped} />);
    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Canada Post' } });
    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: '1Z999' } });
    fireEvent.click(screen.getByRole('button', { name: /mark shipped/i }));

    await waitFor(() => expect(markPartsShippedMock).toHaveBeenCalledTimes(1));
    expect(markPartsShippedMock.mock.calls[0]).toEqual([
      'o-62', { carrier: 'Canada Post', tracking_num: '1Z999' },
    ]);
    expect(onShipped).toHaveBeenCalled();
  });

  it('ships with no tracking at all — most parts go out in an envelope', async () => {
    render(<StepPartsOnly row={row} order={order} onShipped={onShipped} />);
    fireEvent.click(screen.getByRole('button', { name: /mark shipped/i }));
    await waitFor(() => expect(markPartsShippedMock).toHaveBeenCalledTimes(1));
    expect(markPartsShippedMock.mock.calls[0][1]).toEqual({ carrier: '', tracking_num: '' });
  });

  it('shows a failure rather than reporting a shipment that was refused', async () => {
    markPartsShippedMock.mockRejectedValueOnce(new Error('R-0062 carries a whole unit.'));
    render(<StepPartsOnly row={row} order={order} onShipped={onShipped} />);
    fireEvent.click(screen.getByRole('button', { name: /mark shipped/i }));
    expect(await screen.findByText(/carries a whole unit/)).toBeInTheDocument();
    expect(onShipped).not.toHaveBeenCalled();
  });
});
