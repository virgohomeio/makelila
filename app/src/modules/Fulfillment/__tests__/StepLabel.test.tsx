import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmLabelMock } = vi.hoisted(() => ({
  // Typed with its real signature so the patch argument can be asserted on.
  confirmLabelMock: vi.fn((_id: string, _patch: Record<string, unknown>) => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, confirmLabel: confirmLabelMock };
});

// The Goorooship half of step 3 has its own tests; it renders nothing for
// stock on our own floor, which is the case under test here.
vi.mock('../queue/EzTransPanel', () => ({ EzTransPanel: () => null }));

import { StepLabel } from '../queue/StepLabel';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { EzTransOrder } from '../queue/EzTransPanel';

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: 'LL01-00000000358', assigned_serials: ['LL01-00000000358'],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null, label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false, created_at: '2026-09-01T00:00:00Z',
};

const order = (country: 'US' | 'CA'): EzTransOrder => ({
  id: 'o-1', order_ref: '#1197',
  customer_name: 'Andrea Smithers', customer_email: 'a@example.com', customer_phone: null,
  address_line: '1 Main St', address_line2: null, city: 'West Fork',
  region_state: 'AR', postal_code: '72774', country,
});

const labelled = { ...row, carrier: 'UPS', tracking_num: '1Z2985EADK98125759' };

describe('StepLabel — the Freightcom details are the whole gate', () => {
  beforeEach(() => confirmLabelMock.mockClear());

  it('lets a US order through on carrier + tracking alone, like a CA one', () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });

  it('still lets a CA order through', () => {
    render(<StepLabel row={labelled} order={order('CA')} />);
    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
  });

  it('names the missing Freightcom fields when they are blank', () => {
    render(<StepLabel row={row} order={order('US')} />);

    const blockers = screen.getByTestId('step-blockers');
    expect(blockers).toHaveTextContent(/carrier/i);
    expect(blockers).toHaveTextContent(/tracking number/i);
    // The Amazon number is recorded when known, never demanded.
    expect(blockers).not.toHaveTextContent(/compost starter/i);
  });

  it('keeps the starter field for US orders and saves what is typed there', async () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    fireEvent.change(screen.getByPlaceholderText(/Amazon order details/i), {
      target: { value: 'TBA303011917292' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pickup scheduled/ }));

    await waitFor(() => expect(confirmLabelMock).toHaveBeenCalledWith('q-1', expect.objectContaining({
      carrier: 'UPS',
      tracking_num: '1Z2985EADK98125759',
      starter_tracking_num: 'TBA303011917292',
    })));
  });

  it('omits the starter field entirely when it was left blank', async () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    fireEvent.click(screen.getByRole('button', { name: /Pickup scheduled/ }));

    await waitFor(() => expect(confirmLabelMock).toHaveBeenCalled());
    expect(confirmLabelMock.mock.calls[0][1]).not.toHaveProperty('starter_tracking_num');
  });
});

// Clicking this button is what schedules the pickup: the row moves to the dock
// handoff and into "To be picked up", where it reads as a carton the carrier
// is coming for. EZ Trans only come for a box they have been emailed about.
describe('StepLabel — an EZ Trans carton needs the Goorooship email first', () => {
  beforeEach(() => confirmLabelMock.mockClear());

  it('blocks the pickup on an EZ Trans order the 3PL has not been emailed', () => {
    render(<StepLabel row={labelled} order={order('CA')} isEzTrans />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/Goorooship email/i);
  });

  it('names the email alongside the fields still missing, not instead of them', () => {
    render(<StepLabel row={row} order={order('CA')} isEzTrans />);

    const blockers = screen.getByTestId('step-blockers');
    expect(blockers).toHaveTextContent(/carrier/i);
    expect(blockers).toHaveTextContent(/tracking number/i);
    expect(blockers).toHaveTextContent(/Goorooship email/i);
  });

  it('opens once the email has gone out', async () => {
    render(
      <StepLabel
        row={labelled}
        order={order('CA')}
        isEzTrans
        goorooshipSentAt="2026-10-05T17:40:00Z"
      />,
    );

    const btn = screen.getByRole('button', { name: /Pickup scheduled/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(confirmLabelMock).toHaveBeenCalled());
  });

  // Stock off our own floor books through Freightcom and EZ Trans is never
  // emailed about it. Demanding a send there would close the step for good.
  it('asks for no email on a Freightcom carton', () => {
    render(<StepLabel row={labelled} order={order('CA')} isEzTrans={false} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });
});
