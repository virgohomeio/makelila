import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { assignUnitsMock, useUnitsMock } = vi.hoisted(() => ({
  assignUnitsMock: vi.fn(() => Promise.resolve()),
  useUnitsMock: vi.fn(),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, assignUnits: assignUnitsMock };
});

vi.mock('../../../lib/stock', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/stock')>('../../../lib/stock');
  return { ...actual, useUnits: useUnitsMock };
});

import { StepAssign } from '../queue/StepAssign';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: null, assigned_serials: [],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null, label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false,
  created_at: '2026-10-01T00:00:00Z',
};

const unit = (serial: string, over: Record<string, unknown> = {}) => ({
  serial, batch: 'P100', status: 'ready', location: 'Shelf A',
  customer_name: null, customer_id: null,
  electrical_check: 'pass', mechanical_check: 'pass',
  ...over,
});

// James San Roman's order: three machines on one line.
const threeUnitOrder = { line_items: [{ sku: '', name: 'LILA Pro', qty: 3, price_usd: 0 }] };

const READY = [unit('LL01-00000000401'), unit('LL01-00000000402'), unit('LL01-00000000403')];

// One spy for the file, cleared per test: vi.spyOn on the same object returns
// the SAME spy, so re-spying in beforeEach kept every earlier call on the
// record and "was confirm asked?" assertions read other tests' calls.
const confirmSpy = vi.spyOn(window, 'confirm');

beforeEach(() => {
  assignUnitsMock.mockClear();
  assignUnitsMock.mockResolvedValue(undefined);
  useUnitsMock.mockReturnValue({ units: READY, loading: false });
  confirmSpy.mockClear();
  confirmSpy.mockReturnValue(true);
});

describe('StepAssign — picking the machines an order is for', () => {
  it('says how many the order needs', () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);
    expect(screen.getByRole('heading', { name: /Assign 3 ready units/ })).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 picked/)).toBeInTheDocument();
  });

  it('counts up as units are picked and reports completeness', () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByText('00401'));
    expect(screen.getByText(/1 of 3 picked/)).toBeInTheDocument();
    expect(screen.getByText(/2 more to go/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('00402'));
    fireEvent.click(screen.getByText('00403'));
    expect(screen.getByText(/3 of 3 picked/)).toBeInTheDocument();
    expect(screen.getByText(/complete/)).toBeInTheDocument();
  });

  it('assigns every picked unit in one action', async () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByText('00401'));
    fireEvent.click(screen.getByText('00402'));
    fireEvent.click(screen.getByText('00403'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm 3 units/ }));

    await waitFor(() => expect(assignUnitsMock).toHaveBeenCalledTimes(1));
    expect(assignUnitsMock).toHaveBeenCalledWith(
      'q-1',
      ['LL01-00000000401', 'LL01-00000000402', 'LL01-00000000403'],
      'o-1',
    );
  });

  it('unpicks a unit that is clicked again', () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);
    fireEvent.click(screen.getByText('00401'));
    expect(screen.getByText(/1 of 3 picked/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('✓ 00401'));
    expect(screen.getByText(/0 of 3 picked/)).toBeInTheDocument();
  });

  it('keeps a pick visible while a search hides its tile', () => {
    // Picking then searching used to leave no trace of the pick on screen.
    render(<StepAssign row={row} order={threeUnitOrder} />);
    fireEvent.click(screen.getByText('00401'));
    fireEvent.change(screen.getByPlaceholderText(/Search by serial/), { target: { value: '00403' } });

    expect(screen.getByRole('button', { name: /LL01-00000000401 ×/ })).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 picked/)).toBeInTheDocument();
  });

  it('asks before assigning fewer machines than the order is for', async () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByText('00401'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm LL01-00000000401/ }));

    // Under-picking is allowed — what is on the pallet beats a line item — but
    // it sends the row to step 2, and the rest can only be added by rewinding.
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('is for 3 machine'));
    await waitFor(() => expect(assignUnitsMock).toHaveBeenCalledTimes(1));
  });

  it('assigns nothing when that question is declined', async () => {
    confirmSpy.mockReturnValue(false);
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByText('00401'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));

    await waitFor(() => expect(assignUnitsMock).not.toHaveBeenCalled());
  });

  it('does not ask when the pick matches the order', async () => {
    render(<StepAssign row={row} order={threeUnitOrder} />);
    fireEvent.click(screen.getByText('00401'));
    fireEvent.click(screen.getByText('00402'));
    fireEvent.click(screen.getByText('00403'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm 3 units/ }));

    await waitFor(() => expect(assignUnitsMock).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('reads as a single-unit step for a single-unit order', () => {
    render(<StepAssign row={row} order={{ line_items: [{ sku: '', name: 'LILA Pro', qty: 1, price_usd: 2499 }] }} />);
    expect(screen.getByRole('heading', { name: /Assign a ready unit/ })).toBeInTheDocument();
    expect(screen.getByText(/0 of 1 picked/)).toBeInTheDocument();
  });

  it('shows the error from a refused assignment and stays on the step', async () => {
    assignUnitsMock.mockRejectedValueOnce(new Error('needs a database migration that has not been applied yet'));
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByText('00401'));
    fireEvent.click(screen.getByText('00402'));
    fireEvent.click(screen.getByText('00403'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm 3 units/ }));

    await waitFor(() =>
      expect(screen.getByText(/needs a database migration/)).toBeInTheDocument());
    expect(screen.getByText(/3 of 3 picked/)).toBeInTheDocument();
  });

  it('flags a picked unit that is already shipped as a backfill', () => {
    useUnitsMock.mockReturnValue({
      units: [unit('LL01-00000000401'), unit('LL01-00000000999', { status: 'shipped' })],
      loading: false,
    });
    render(<StepAssign row={row} order={threeUnitOrder} />);

    fireEvent.click(screen.getByLabelText(/Backfill mode/));
    fireEvent.click(screen.getByText('00999'));
    expect(screen.getByText(/already shipped/)).toBeInTheDocument();
  });
});
