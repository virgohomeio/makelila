import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type SaveLabelInput = { carrier: string; tracking_num: string; label_pdf?: File };

const { placementMock, saveLabelMock, sendMock, logActionMock } = vi.hoisted(() => ({
  placementMock: vi.fn(),
  // Declared with its real signature so `mock.calls[0]` is typed and the
  // assertions below need no cast — a cast in a test file is a tsc -b failure
  // waiting to happen, and tsc -b is what gates the deploy.
  saveLabelMock: vi.fn(
    (queueId: string, input: { carrier: string; tracking_num: string; label_pdf?: File }) => {
      void queueId; void input;
      return Promise.resolve({ label_pdf_path: 'q-1/label-1.pdf' });
    },
  ),
  sendMock: vi.fn((queueId: string) => {
    void queueId;
    return Promise.resolve({ email_id: 're_1' });
  }),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/eztrans', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/eztrans')>('../../../lib/eztrans');
  return {
    ...actual,
    useEzTransPlacement: placementMock,
    saveEzTransLabel: saveLabelMock,
    sendEzTransBooking: sendMock,
  };
});

vi.mock('../../../lib/activityLog', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/activityLog')>('../../../lib/activityLog');
  return {
    ...actual,
    logAction: logActionMock,
    useActivityForEntity: () => ({ entries: [], loading: false }),
  };
});

import { EzTransPanel } from '../queue/EzTransPanel';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: 'LL01-P100X-00412',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null,
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false,
  created_at: '2026-09-18T00:00:00Z',
};

const order = {
  id: 'o-1', order_ref: '#1184',
  customer_name: 'Juanita M Wells',
  customer_email: 'juanita@example.com',
  customer_phone: '+17095551234',
  address_line: '14 Grenfell Drive', address_line2: null,
  city: 'Wabush', region_state: 'NL', postal_code: 'A0R 1B0',
  country: 'CA' as const,
};

const AT_EZTRANS = {
  placement: { serial: 'LL01-P100X-00412', skid: 'EZ-P01', pallet: 'P01', masterCarton: '1' },
  loading: false,
};

function labelFile() {
  return new File(['%PDF-1.4'], 'goorooship-label.pdf', { type: 'application/pdf' });
}

function fillLabel() {
  fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Purolator' } });
  fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'PUR123456789' } });
  fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
}

const sendButton = () => screen.getByRole('button', { name: /send confirmation to cs@goorooship\.ca/i });

describe('EzTransPanel', () => {
  beforeEach(() => {
    placementMock.mockReset().mockReturnValue(AT_EZTRANS);
    saveLabelMock.mockClear();
    sendMock.mockClear();
    logActionMock.mockClear();
  });

  it('stays out of the way for a unit that is not at EZ Trans', () => {
    placementMock.mockReturnValue({ placement: null, loading: false });
    const { container } = render(<EzTransPanel row={row} order={order} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers the Goorooship booking link for a unit that is', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(screen.getByRole('link', { name: /goorooship — book a shipment/i }))
      .toHaveAttribute('href', 'https://app.goorooship.ca/ship');
  });

  it('will not send until carrier, tracking and the label are all present', () => {
    render(<EzTransPanel row={row} order={order} />);
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/carrier/i), { target: { value: 'Purolator' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: 'PUR123456789' } });
    expect(sendButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/shipping label pdf/i), { target: { files: [labelFile()] } });
    expect(sendButton()).toBeEnabled();
  });

  it('saves the label before sending, so the email attaches what the row holds', async () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('q-1'));
    expect(saveLabelMock).toHaveBeenCalledTimes(1);
    const [queueId, input]: [string, SaveLabelInput] = saveLabelMock.mock.calls[0];
    expect(queueId).toBe('q-1');
    expect(input.carrier).toBe('Purolator');
    expect(input.tracking_num).toBe('PUR123456789');
    expect(input.label_pdf?.name).toBe('goorooship-label.pdf');
    // Order matters: a send that beat the save would email the previous label.
    expect(saveLabelMock.mock.invocationCallOrder[0])
      .toBeLessThan(sendMock.mock.invocationCallOrder[0]);
  });

  it('hands the label details up so Confirm label does not ask for them again', async () => {
    const onLabelSaved = vi.fn();
    render(<EzTransPanel row={row} order={order} onLabelSaved={onLabelSaved} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(onLabelSaved).toHaveBeenCalledWith({
      carrier: 'Purolator', tracking_num: 'PUR123456789',
    }));
  });

  it('does not make the operator find the label file again on a second pass', () => {
    // A row rewound from step 4, or one where the first send failed: carrier,
    // tracking and the label are already on the row, so the send is unblocked
    // with nothing retyped and nothing re-uploaded.
    render(
      <EzTransPanel
        row={{ ...row, carrier: 'UPS', tracking_num: '1ZABC', label_pdf_path: 'q-1/label-0.pdf' }}
        order={order}
      />,
    );
    expect(screen.getByLabelText(/carrier/i)).toHaveValue('UPS');
    expect(screen.getByLabelText(/tracking number/i)).toHaveValue('1ZABC');
    expect(sendButton()).toBeEnabled();
    expect(screen.getByText(/already on this order/i)).toBeInTheDocument();
  });

  it('does not log a send that failed', async () => {
    sendMock.mockRejectedValueOnce(new Error('Resend 502'));
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/Resend 502/)).toBeInTheDocument());
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('previews the email with the master carton read off the pallet', () => {
    render(<EzTransPanel row={row} order={order} />);
    fillLabel();
    fireEvent.click(screen.getByRole('button', { name: /preview email/i }));
    const preview = screen.getAllByText(/Master Carton: 1/).length;
    expect(preview).toBeGreaterThan(0);
    expect(screen.getByText(/Tracking Number: PUR123456789/)).toBeInTheDocument();
  });
});
