// Can an operator actually confirm the label on a Freightcom order?
//
// StepLabel.test mocks both booking panels out to isolate the gates, and
// FreightcomPanel.test renders the panel on its own. Neither answers the
// question the operator is actually asking, which spans the two: step 3 has to
// *choose* the Freightcom panel for stock on our own floor, the panel's
// confirm has to reach the row, and "Pickup scheduled" — which is gated on
// that confirm — has to open as a result. Mock the seam and all three can be
// true separately while the step stays shut.
//
// So this drives the real step with the real panel: nothing between the click
// and the two writes is stood in for.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmLabelMock, saveQueueLabelMock, logActionMock } = vi.hoisted(() => ({
  confirmLabelMock: vi.fn((_id: string, _patch: Record<string, unknown>) => Promise.resolve()),
  // The one real write the panel makes, stood in for at the Supabase edge
  // rather than at the module boundary — so confirmFreightcomBooking itself,
  // and the log line it writes, are the code under test.
  saveQueueLabelMock: vi.fn(
    (queueId: string, input: { carrier: string; tracking_num: string; label_pdf?: File }) => {
      void queueId; void input;
      return Promise.resolve({ label_pdf_path: 'q-1169/label-1760000000000.pdf' });
    },
  ),
  logActionMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, confirmLabel: confirmLabelMock, saveQueueLabel: saveQueueLabelMock };
});

vi.mock('../../../lib/activityLog', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/activityLog')>('../../../lib/activityLog');
  return { ...actual, logAction: logActionMock, useActivityForEntity: () => ({ entries: [], loading: false }) };
});

// The Goorooship panel renders nothing for stock on our own floor anyway, but
// it reaches Supabase to find that out. This test is about the other branch.
vi.mock('../queue/EzTransPanel', async () => {
  const actual = await vi.importActual<typeof import('../queue/EzTransPanel')>('../queue/EzTransPanel');
  return { ...actual, EzTransPanel: () => null };
});

// The starter card's writes go straight to Supabase; the rules stay real.
vi.mock('../../../lib/starterKit', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/starterKit')>('../../../lib/starterKit');
  return {
    ...actual,
    saveStarterTracking: vi.fn(() => Promise.resolve()),
    skipStarterKit: vi.fn(() => Promise.resolve()),
    unskipStarterKit: vi.fn(() => Promise.resolve()),
  };
});

import { StepLabel } from '../queue/StepLabel';
import { FREIGHTCOM_CONFIRMED_ACTION } from '../../../lib/freightcomBooking';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { EzTransOrder } from '../queue/EzTransPanel';

// #1169 — the one row at step 3 on 2026-10-08 whose machines are not at the
// EZ Trans 3PL. Its two units are in Langley, BC, so it books through
// Freightcom, and it is the order this whole change is for.
const row: FulfillmentQueueRow = {
  id: 'q-1169', order_id: 'o-1169', step: 3,
  assigned_serial: 'LL01-00000000358',
  assigned_serials: ['LL01-00000000358', 'LL01-00000000412'],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null,
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: 'TBA303011917292',
  email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false,
  created_at: '2026-09-01T00:00:00Z',
};

const order: EzTransOrder & { kind: 'sale' | 'replacement' } = {
  id: 'o-1169', order_ref: '#1169', kind: 'sale',
  customer_name: 'Andrea Smithers', customer_email: 'a@example.com', customer_phone: null,
  address_line: '1 Main St', address_line2: null, city: 'Langley',
  region_state: 'BC', postal_code: 'V3A 4R2', country: 'CA',
};

const pdfFile = () => new File(['%PDF-1.4'], 'freightcom-label.pdf', { type: 'application/pdf' });

describe('confirming the label on a Freightcom order, end to end', () => {
  beforeEach(() => {
    confirmLabelMock.mockClear();
    saveQueueLabelMock.mockClear();
    logActionMock.mockClear();
  });

  it('walks the operator from a blank step to a scheduled pickup', async () => {
    render(<StepLabel row={row} order={order} isEzTrans={false} />);

    // Step 3 picked the Freightcom panel, and nothing is confirmed yet.
    expect(screen.getByTestId('freightcom-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('freightcom-confirmed')).toBeNull();
    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/Freightcom booking/i);

    // The label Freightcom issued, recorded the same way the Goorooship one is.
    fireEvent.change(screen.getByTestId('freightcom-carrier'), { target: { value: 'Purolator' } });
    fireEvent.change(screen.getByTestId('freightcom-tracking'), { target: { value: '520766148800' } });
    fireEvent.change(screen.getByTestId('freightcom-label-pdf'), { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    // The booking reached the row...
    await waitFor(() => expect(saveQueueLabelMock).toHaveBeenCalledWith('q-1169', expect.objectContaining({
      carrier: 'Purolator', tracking_num: '520766148800',
    })));
    expect(saveQueueLabelMock.mock.calls[0][1].label_pdf).toBeInstanceOf(File);

    // ...and the order's history says so, against the order rather than the
    // queue row, which is where the Goorooship sends put theirs.
    await waitFor(() => expect(logActionMock).toHaveBeenCalledWith(
      FREIGHTCOM_CONFIRMED_ACTION,
      '#1169',
      expect.stringContaining('Purolator 520766148800'),
      expect.objectContaining({ entityType: 'order', entityId: 'o-1169' }),
    ));
    expect(logActionMock.mock.calls[0][2]).toMatch(/2 unit\(s\)/);

    // The panel says the booking is on the record...
    expect(await screen.findByTestId('freightcom-confirmed')).toHaveTextContent(/booking confirmed/i);

    // ...and the last gate on the step has opened, without a reload and
    // without waiting on realtime to bring the row back.
    const pickup = screen.getByRole('button', { name: /Pickup scheduled/ });
    await waitFor(() => expect(pickup).toBeEnabled());
    expect(screen.queryByTestId('step-blockers')).toBeNull();

    // One click, with the label details the panel already saved — not retyped.
    fireEvent.click(pickup);
    await waitFor(() => expect(confirmLabelMock).toHaveBeenCalledWith('q-1169', expect.objectContaining({
      carrier: 'Purolator',
      tracking_num: '520766148800',
      starter_tracking_num: 'TBA303011917292',
    })));
  });

  // The failure that would be invisible: a confirm that throws, a panel that
  // shows the error, and a step that opens anyway because the gate had already
  // been flipped optimistically.
  it('leaves the step shut when the confirm fails', async () => {
    saveQueueLabelMock.mockRejectedValueOnce(new Error('storage upload failed'));
    render(<StepLabel row={row} order={order} isEzTrans={false} />);

    fireEvent.change(screen.getByTestId('freightcom-carrier'), { target: { value: 'Purolator' } });
    fireEvent.change(screen.getByTestId('freightcom-tracking'), { target: { value: '520766148800' } });
    fireEvent.change(screen.getByTestId('freightcom-label-pdf'), { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    await waitFor(() => expect(screen.getByTestId('freightcom-panel'))
      .toHaveTextContent(/storage upload failed/));
    expect(logActionMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('freightcom-confirmed')).toBeNull();
    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/Freightcom booking/i);
  });

  // An order whose machines ARE at the 3PL must not get this panel: it would
  // offer a Freightcom booking for a carton Goorooship is collecting.
  it('does not offer the Freightcom panel on an EZ Trans order', () => {
    render(<StepLabel row={row} order={order} isEzTrans goorooshipSentAt="2026-10-05T17:40:00Z" />);

    expect(screen.queryByTestId('freightcom-panel')).toBeNull();
  });
});
