import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmBookingMock } = vi.hoisted(() => ({
  // Declared with its real signature so `mock.calls[0]` is typed and the
  // assertions below need no cast — a cast in a test file is a tsc -b failure
  // waiting to happen, and tsc -b is what gates the deploy.
  confirmBookingMock: vi.fn(
    (queueId: string, input: {
      carrier: string; tracking_num: string; label_pdf?: File;
      extra_packages?: { tracking_num: string; label_pdf?: File | null; label_pdf_path?: string | null }[];
      order: { id: string; order_ref: string }; serials: string[];
    }) => {
      void queueId; void input;
      return Promise.resolve({
        label_pdf_path: 'q-1/label-1.pdf',
        extra_packages: null as { tracking_num: string; label_pdf_path: string }[] | null,
      });
    },
  ),
}));

// Only the write is stubbed. `freightcomBookingConfirmed` stays real — it is
// the rule the panel and the step's last gate both read, and standing it in
// would leave the thing under test untested.
vi.mock('../../../lib/freightcomBooking', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/freightcomBooking')>(
    '../../../lib/freightcomBooking',
  );
  return { ...actual, confirmFreightcomBooking: confirmBookingMock };
});

import { FreightcomPanel } from '../queue/FreightcomPanel';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { EzTransOrder } from '../queue/EzTransPanel';

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 3,
  assigned_serial: 'LL01-00000000358', assigned_serials: ['LL01-00000000358'],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null,
  label_pdf_path: null, label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false,
  created_at: '2026-09-01T00:00:00Z',
};

const order: EzTransOrder = {
  id: 'o-1', order_ref: '#1197',
  customer_name: 'Andrea Smithers', customer_email: 'a@example.com', customer_phone: null,
  address_line: '1 Main St', address_line2: null, city: 'West Fork',
  region_state: 'AR', postal_code: '72774', country: 'US',
};

const pdfFile = () => new File(['%PDF-1.4'], 'freightcom-label.pdf', { type: 'application/pdf' });

/** Carrier, tracking and the label all on the row — a booking already made. */
const booked = {
  ...row,
  carrier: 'UPS',
  tracking_num: '1Z2985EADK98125759',
  label_pdf_path: 'q-1/label-1760000000000.pdf',
};

describe('FreightcomPanel — booking a Freightcom shipment is the same four moves as a Goorooship one', () => {
  beforeEach(() => confirmBookingMock.mockClear());

  // The point of the panel. Goorooship's half of step 3 has always said "book
  // it on the portal first, then record what the portal gave you"; the
  // Freightcom half said nothing at all, and the operator met a bare carrier
  // dropdown with no instruction about where the number comes from.
  it('sends the operator to the Freightcom portal before asking for anything', () => {
    render(<FreightcomPanel row={row} order={order} />);

    const link = screen.getByRole('link', { name: /Freightcom/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('live.freightcom.com'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('freightcom-panel')).toHaveTextContent(/Book it first/i);
  });

  // The whole reason this panel exists. The label PDF was an optional field on
  // the old card and optional meant empty: 28 of the 111 rows that reached
  // step 6 carry a label, and 12 of those 28 are EZ Trans rows — the only ones
  // where it was ever demanded.
  it('will not confirm on a carrier and a tracking number alone', () => {
    render(<FreightcomPanel row={row} order={order} />);

    fireEvent.change(screen.getByTestId('freightcom-carrier'), { target: { value: 'UPS' } });
    fireEvent.change(screen.getByTestId('freightcom-tracking'), {
      target: { value: '1Z2985EADK98125759' },
    });

    expect(screen.getByTestId('freightcom-confirm')).toBeDisabled();
    expect(screen.getByTestId('freightcom-panel')).toHaveTextContent(/label PDF are all required/i);
  });

  it('confirms once the carrier, the number and the label are all there', async () => {
    render(<FreightcomPanel row={row} order={order} />);

    fireEvent.change(screen.getByTestId('freightcom-carrier'), { target: { value: 'UPS' } });
    fireEvent.change(screen.getByTestId('freightcom-tracking'), {
      target: { value: '  1Z2985EADK98125759  ' },
    });
    fireEvent.change(screen.getByTestId('freightcom-label-pdf'), {
      target: { files: [pdfFile()] },
    });

    const btn = screen.getByTestId('freightcom-confirm');
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() => expect(confirmBookingMock).toHaveBeenCalledWith('q-1', expect.objectContaining({
      carrier: 'UPS',
      // Trimmed: a pasted tracking number carries the portal's whitespace, and
      // a number with a space on the end matches nothing at the carrier.
      tracking_num: '1Z2985EADK98125759',
      order: { id: 'o-1', order_ref: '#1197' },
      serials: ['LL01-00000000358'],
    })));
    expect(confirmBookingMock.mock.calls[0][1].label_pdf).toBeInstanceOf(File);
  });

  // "Pickup scheduled" lives in StepLabel, which asks for the carrier and the
  // number again. Making the operator type them twice is how one of the two
  // copies ends up wrong.
  it('hands the label details up so the step closes in one click', async () => {
    const onLabelSaved = vi.fn();
    const onConfirmed = vi.fn();
    render(
      <FreightcomPanel
        row={booked}
        order={order}
        onLabelSaved={onLabelSaved}
        onConfirmed={onConfirmed}
      />,
    );

    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    await waitFor(() => expect(onLabelSaved).toHaveBeenCalledWith({
      carrier: 'UPS', tracking_num: '1Z2985EADK98125759',
    }));
    expect(onConfirmed).toHaveBeenCalled();
  });

  // A label already on the row is the booking already made. Demanding the file
  // again to fix a mistyped tracking number would send the operator back to
  // the portal to re-download something we already hold.
  it('takes a booking already on the row as confirmed, and lets it be corrected', () => {
    render(<FreightcomPanel row={booked} order={order} />);

    expect(screen.getByTestId('freightcom-confirmed')).toHaveTextContent(/booking confirmed/i);
    expect(screen.getByTestId('freightcom-confirm')).toBeEnabled();
    expect(screen.getByTestId('freightcom-confirm')).toHaveTextContent(/Update this booking/i);
    expect(screen.getByTestId('freightcom-panel')).toHaveTextContent(/pick a file only to replace it/i);
  });

  it('seeds the fields from the row so nothing is retyped after a rewind', () => {
    render(<FreightcomPanel row={booked} order={order} />);

    expect(screen.getByTestId('freightcom-carrier')).toHaveValue('UPS');
    expect(screen.getByTestId('freightcom-tracking')).toHaveValue('1Z2985EADK98125759');
  });

  // The compost starter is bought on Amazon and never touches this carton, but
  // step 3 is the last moment anyone looks at the order — and the Goorooship
  // panel is held the same way, by the same answer computed once in StepLabel.
  it('is held shut while the compost starter is outstanding', () => {
    render(
      <FreightcomPanel row={booked} order={order} starterGap="the compost starter's Amazon tracking number" />,
    );

    expect(screen.getByTestId('freightcom-confirm')).toBeDisabled();
    expect(screen.getByTestId('freightcom-panel')).toHaveTextContent(/compost starter comes first/i);
  });

  it('reports a failed confirm rather than claiming the booking is on the record', async () => {
    confirmBookingMock.mockRejectedValueOnce(new Error('storage upload failed'));
    render(<FreightcomPanel row={booked} order={order} />);

    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    await waitFor(() => expect(screen.getByTestId('freightcom-panel'))
      .toHaveTextContent(/storage upload failed/));
  });

  // An order for three machines is one Freightcom shipment, and the panel is
  // the last place the operator can count them against the box.
  it('names every machine on the order, not just the first', () => {
    render(
      <FreightcomPanel
        row={{ ...booked, assigned_serials: ['LL01-00000000358', 'LL01-00000000412'] }}
        order={order}
      />,
    );

    const panel = screen.getByTestId('freightcom-panel');
    expect(panel).toHaveTextContent('LL01-00000000358');
    expect(panel).toHaveTextContent('LL01-00000000412');
    expect(panel).toHaveTextContent(/2 machines ship/i);
  });
});

// Order #1341: three machines, three Freightcom labels. The row held one
// tracking number and one label, so boxes 2 and 3 had nowhere to go.
describe('FreightcomPanel — a booking with several boxes', () => {
  beforeEach(() => confirmBookingMock.mockClear());

  const three: FulfillmentQueueRow = {
    ...row,
    assigned_serial: 'LL01-1',
    assigned_serials: ['LL01-1', 'LL01-2', 'LL01-3'],
  };

  it('nudges a multi-machine order to add a box per label, without forcing it', () => {
    render(<FreightcomPanel row={three} order={order} />);
    expect(screen.getByTestId('freightcom-box-nudge')).toHaveTextContent('3 machines, 1 label');
    fireEvent.click(screen.getByTestId('freightcom-add-box'));
    fireEvent.click(screen.getByTestId('freightcom-add-box'));
    expect(screen.queryByTestId('freightcom-box-nudge')).toBeNull();
    expect(screen.getByTestId('freightcom-box-3')).toHaveTextContent('Box 3 of 3');
  });

  it('needs a tracking number and label for every box, then saves them all', async () => {
    render(<FreightcomPanel row={three} order={order} />);
    fireEvent.change(screen.getByTestId('freightcom-carrier'), { target: { value: 'UPS' } });
    fireEvent.click(screen.getByTestId('freightcom-add-box'));
    fireEvent.click(screen.getByTestId('freightcom-add-box'));

    fireEvent.change(screen.getByTestId('freightcom-tracking'), { target: { value: '1ZAAA' } });
    fireEvent.change(screen.getByTestId('freightcom-label-pdf'), { target: { files: [pdfFile()] } });
    fireEvent.change(screen.getByTestId('freightcom-tracking-2'), { target: { value: '1ZBBB' } });
    fireEvent.change(screen.getByTestId('freightcom-label-pdf-2'), { target: { files: [pdfFile()] } });
    fireEvent.change(screen.getByTestId('freightcom-tracking-3'), { target: { value: '1ZCCC' } });

    // Box 3 has no label yet.
    expect(screen.getByTestId('freightcom-confirm')).toBeDisabled();

    fireEvent.change(screen.getByTestId('freightcom-label-pdf-3'), { target: { files: [pdfFile()] } });
    expect(screen.getByTestId('freightcom-confirm')).toBeEnabled();
    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    await waitFor(() => expect(confirmBookingMock).toHaveBeenCalledTimes(1));
    const input = confirmBookingMock.mock.calls[0][1];
    expect(input.tracking_num).toBe('1ZAAA');
    expect(input.label_pdf).toBeInstanceOf(File);
    expect(input.extra_packages?.map(p => p.tracking_num)).toEqual(['1ZBBB', '1ZCCC']);
    expect(input.extra_packages?.every(p => p.label_pdf instanceof File)).toBe(true);
  });

  it('reloads saved boxes, and removing one drops it from the record', async () => {
    const saved = {
      ...three,
      carrier: 'UPS', tracking_num: '1ZAAA', label_pdf_path: 'q-1/a.pdf',
      extra_packages: [
        { tracking_num: '1ZBBB', label_pdf_path: 'q-1/b.pdf' },
        { tracking_num: '1ZCCC', label_pdf_path: 'q-1/c.pdf' },
      ],
    };
    render(<FreightcomPanel row={saved} order={order} />);
    expect(screen.getByTestId('freightcom-tracking-3')).toHaveValue('1ZCCC');
    expect(screen.getByTestId('freightcom-confirmed')).toHaveTextContent('1ZAAA, 1ZBBB, 1ZCCC');

    fireEvent.click(screen.getByTestId('freightcom-remove-box-2'));
    fireEvent.click(screen.getByTestId('freightcom-confirm'));

    await waitFor(() => expect(confirmBookingMock).toHaveBeenCalledTimes(1));
    const input = confirmBookingMock.mock.calls[0][1];
    expect(input.label_pdf).toBeUndefined();
    expect(input.extra_packages).toEqual([
      { tracking_num: '1ZCCC', label_pdf: null, label_pdf_path: 'q-1/c.pdf' },
    ]);
  });
});
