import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmLabelMock, saveStarterMock, skipStarterMock, unskipStarterMock } = vi.hoisted(() => ({
  // Typed with its real signature so the patch argument can be asserted on.
  confirmLabelMock: vi.fn((_id: string, _patch: Record<string, unknown>) => Promise.resolve()),
  saveStarterMock: vi.fn((_id: string, _tracking: string) => Promise.resolve()),
  skipStarterMock: vi.fn((_id: string, _reason: string, _refs?: unknown) => Promise.resolve()),
  unskipStarterMock: vi.fn((_id: string, _refs?: unknown) => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, confirmLabel: confirmLabelMock };
});

// The pure half of the starter rules is left real — it is the gate under test.
// Only the three functions that reach the database are stood in for.
vi.mock('../../../lib/starterKit', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/starterKit')>('../../../lib/starterKit');
  return {
    ...actual,
    saveStarterTracking: saveStarterMock,
    skipStarterKit: skipStarterMock,
    unskipStarterKit: unskipStarterMock,
  };
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

type StepLabelOrder = EzTransOrder & { kind: 'sale' | 'replacement' };

const order = (country: 'US' | 'CA', kind: 'sale' | 'replacement' = 'sale'): StepLabelOrder => ({
  id: 'o-1', order_ref: '#1197', kind,
  customer_name: 'Andrea Smithers', customer_email: 'a@example.com', customer_phone: null,
  address_line: '1 Main St', address_line2: null, city: 'West Fork',
  region_state: 'AR', postal_code: '72774', country,
});

/** Carrier and Freightcom tracking done — the starter still outstanding. */
const labelled = { ...row, carrier: 'UPS', tracking_num: '1Z2985EADK98125759' };
/** And the starter answered with a number. */
const starterOrdered = { ...labelled, starter_tracking_num: 'TBA303011917292' };

describe('StepLabel — the compost starter is part of scheduling the pickup', () => {
  beforeEach(() => {
    confirmLabelMock.mockClear();
    saveStarterMock.mockClear();
    skipStarterMock.mockClear();
    unskipStarterMock.mockClear();
  });

  // The whole point of the change. A labelled carton used to be good to go;
  // the bag of soil the customer paid for was nobody's checklist item.
  it('holds a labelled sale until the starter is answered', () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/compost starter/i);
  });

  it('holds a CA sale too — the starter was never a US-only product', () => {
    render(<StepLabel row={labelled} order={order('CA')} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/compost starter/i);
  });

  it('names it alongside the Freightcom fields, not instead of them', () => {
    render(<StepLabel row={row} order={order('US')} />);

    const blockers = screen.getByTestId('step-blockers');
    expect(blockers).toHaveTextContent(/carrier/i);
    expect(blockers).toHaveTextContent(/tracking number/i);
    expect(blockers).toHaveTextContent(/compost starter/i);
  });

  it('opens the step once the Amazon number is typed, and saves it', async () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    fireEvent.change(screen.getByTestId('starter-tracking-input'), {
      target: { value: 'TBA303011917292' },
    });

    const btn = screen.getByRole('button', { name: /Pickup scheduled/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    await waitFor(() => expect(confirmLabelMock).toHaveBeenCalledWith('q-1', expect.objectContaining({
      carrier: 'UPS',
      tracking_num: '1Z2985EADK98125759',
      starter_tracking_num: 'TBA303011917292',
    })));
  });

  // The number gates the Goorooship email, which goes out before this step
  // ends — so it has to be on the row before Confirm, not at it.
  it('writes the number to the row as soon as the field is left', async () => {
    render(<StepLabel row={labelled} order={order('CA')} />);

    const input = screen.getByTestId('starter-tracking-input');
    fireEvent.change(input, { target: { value: 'TBA303011917292' } });
    fireEvent.blur(input);

    await waitFor(() => expect(saveStarterMock).toHaveBeenCalledWith('q-1', 'TBA303011917292'));
  });

  it('takes a number already on the row as the answer', () => {
    render(<StepLabel row={starterOrdered} order={order('CA')} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });

  it('points the operator at the storefront that ships to them', () => {
    const { unmount } = render(<StepLabel row={labelled} order={order('CA')} />);
    expect(screen.getByRole('link', { name: /Amazon\.ca/ })).toHaveAttribute(
      'href', expect.stringContaining('amazon.ca'),
    );
    unmount();

    render(<StepLabel row={labelled} order={order('US')} />);
    expect(screen.getByRole('link', { name: /Amazon\.com/ })).toHaveAttribute(
      'href', expect.stringContaining('amazon.com'),
    );
  });
});

// This gate was shipped once before keyed on country alone, and an order that
// shipped no starter kit had no number to paste and no way past step 3
// (5a01566). Both escapes are tested, because a gate with no way round it is
// the bug, not the feature.
describe('StepLabel — an order that ships no starter is not stranded', () => {
  beforeEach(() => {
    confirmLabelMock.mockClear();
    skipStarterMock.mockClear();
  });

  it('asks nothing of a replacement, and shows it no card', () => {
    render(<StepLabel row={labelled} order={order('US', 'replacement')} />);

    expect(screen.queryByTestId('starter-kit-card')).toBeNull();
    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });

  it('lets a sale through on a declared exemption, with a reason', async () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    fireEvent.click(screen.getByRole('button', { name: /ships no starter soil/i }));
    fireEvent.change(screen.getByTestId('starter-skip-reason'), {
      target: { value: 'customer already has one from #1142' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record this and carry on/i }));

    await waitFor(() => expect(skipStarterMock).toHaveBeenCalledWith(
      'q-1', 'customer already has one from #1142',
      { orderRef: '#1197', orderId: 'o-1' },
    ));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled());
  });

  // A skip with no reason on it is indistinguishable from a starter nobody got
  // round to ordering, which is the thing the whole gate exists to surface.
  it('will not record an exemption with no reason', () => {
    render(<StepLabel row={labelled} order={order('US')} />);

    fireEvent.click(screen.getByRole('button', { name: /ships no starter soil/i }));
    expect(screen.getByRole('button', { name: /Record this and carry on/i })).toBeDisabled();
    expect(skipStarterMock).not.toHaveBeenCalled();
  });

  it('takes an exemption already on the row as the answer', () => {
    render(
      <StepLabel
        row={{ ...labelled, starter_skipped_at: '2026-10-07T12:00:00Z', starter_skip_reason: 'bought in store' }}
        order={order('CA')}
      />,
    );

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.getByTestId('starter-kit-card')).toHaveTextContent(/bought in store/);
  });
});

// Clicking this button is what schedules the pickup: the row moves to the dock
// handoff and into "To be picked up", where it reads as a carton the carrier
// is coming for. EZ Trans only come for a box they have been emailed about.
describe('StepLabel — an EZ Trans carton needs the Goorooship email first', () => {
  beforeEach(() => confirmLabelMock.mockClear());

  it('blocks the pickup on an EZ Trans order the 3PL has not been emailed', () => {
    render(<StepLabel row={starterOrdered} order={order('CA')} isEzTrans />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/Goorooship email/i);
  });

  it('names the email alongside the fields still missing, not instead of them', () => {
    render(<StepLabel row={row} order={order('CA')} isEzTrans />);

    const blockers = screen.getByTestId('step-blockers');
    expect(blockers).toHaveTextContent(/carrier/i);
    expect(blockers).toHaveTextContent(/tracking number/i);
    expect(blockers).toHaveTextContent(/compost starter/i);
    expect(blockers).toHaveTextContent(/Goorooship email/i);
  });

  it('opens once the email has gone out', async () => {
    render(
      <StepLabel
        row={starterOrdered}
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
    render(<StepLabel row={starterOrdered} order={order('CA')} isEzTrans={false} />);

    expect(screen.getByRole('button', { name: /Pickup scheduled/ })).toBeEnabled();
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });
});
