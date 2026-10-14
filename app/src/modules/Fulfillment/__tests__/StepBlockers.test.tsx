import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { assignUnitsMock, useUnitsMock, useOrderRecipientMock, useEmailTemplateMock } = vi.hoisted(() => ({
  assignUnitsMock: vi.fn(() => Promise.resolve()),
  useUnitsMock: vi.fn(),
  useOrderRecipientMock: vi.fn(),
  // Resolved rather than loading, so the step renders its draft — the From/To
  // line only exists once the wording has loaded.
  useEmailTemplateMock: vi.fn(() => ({ template: null, loading: false, refresh: () => Promise.resolve() })),
}));

vi.mock('../../../lib/templates', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/templates')>('../../../lib/templates');
  return { ...actual, useEmailTemplate: useEmailTemplateMock };
});

// The hook reads `customers` for the fallback address, which is a network call.
// Mocked here so the step can be rendered against each resolution it has to
// handle; the resolution itself is unit-tested in lib/orderRecipient.test.ts.
vi.mock('../../../lib/orderRecipient', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orderRecipient')>('../../../lib/orderRecipient');
  return { ...actual, useOrderRecipient: useOrderRecipientMock };
});

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, assignUnits: assignUnitsMock, toggleDockCheck: vi.fn(() => Promise.resolve()) };
});

vi.mock('../../../lib/stock', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/stock')>('../../../lib/stock');
  return { ...actual, useUnits: useUnitsMock };
});

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, markOrderShipped: vi.fn(() => Promise.resolve()) };
});

import { listPhrase } from '../queue/StepBlockers';
import { StepAssign } from '../queue/StepAssign';
import { StepDock } from '../queue/StepDock';
import { StepEmail } from '../queue/StepEmail';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: null, assigned_serials: [],
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: 'UPS', tracking_num: '1ZABC', label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false, dock_picked_up: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, priority: false, created_at: '2026-09-01T00:00:00Z',
};

const readyUnit = {
  serial: 'LL01-00000000401', batch: 'P100', status: 'ready', location: 'Shelf A',
  customer_name: null, customer_id: null, electrical_check: 'pass', mechanical_check: 'pass',
};

describe('listPhrase', () => {
  it('joins one, two and three items the way a sentence would', () => {
    expect(listPhrase([])).toBe('');
    expect(listPhrase(['a'])).toBe('a');
    expect(listPhrase(['a', 'b'])).toBe('a and b');
    expect(listPhrase(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

const singleUnitOrder = { line_items: [{ sku: '', name: 'LILA Pro', qty: 1, price_usd: 2499 }] };

describe('StepAssign — why Confirm is disabled', () => {
  beforeEach(() => {
    assignUnitsMock.mockClear();
    useUnitsMock.mockReturnValue({ units: [readyUnit], loading: false });
  });

  it('asks the operator to pick a unit when none is selected', () => {
    render(<StepAssign row={row} order={singleUnitOrder} />);
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/unit picked/i);
  });

  it('clears the hint once a unit is picked', () => {
    render(<StepAssign row={row} order={singleUnitOrder} />);
    fireEvent.click(screen.getByText('00401'));
    expect(screen.queryByTestId('step-blockers')).toBeNull();
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeEnabled();
  });
});

describe('StepDock — why Confirm is disabled', () => {
  it('names the checklist items still unticked', () => {
    render(<StepDock row={{ ...row, step: 4, dock_printed: true, dock_affixed: true }} />);
    const hint = screen.getByTestId('step-blockers');
    expect(hint).toHaveTextContent(/box on outbound dock/i);
    expect(hint).toHaveTextContent(/carrier picked up/i);
    expect(hint).not.toHaveTextContent(/label printed/i);
  });

  it('says nothing once every box is ticked', () => {
    render(<StepDock row={{
      ...row, step: 4,
      dock_printed: true, dock_affixed: true, dock_docked: true, dock_notified: true, dock_picked_up: true,
    }} />);
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });
});

describe('StepEmail — why Send is disabled', () => {
  const order = (email: string | null) => ({
    id: 'o-1', customer_name: 'Al O Giwa', customer_email: email,
    order_ref: '#1202', country: 'US' as const,
  });

  beforeEach(() => {
    // Default: whatever is on the order row, nothing else linked — the shape
    // every sale has.
    useOrderRecipientMock.mockImplementation((o: { customer_email: string | null }) => ({
      email: o.customer_email, source: o.customer_email ? 'order' : null,
      nameMismatch: false, loading: false,
    }));
  });

  it('calls out a customer with no email on file', () => {
    render(<StepEmail row={{ ...row, step: 5 }} order={order(null)} />);
    const hint = screen.getByTestId('step-blockers');
    expect(hint).toHaveTextContent(/email address/i);
    expect(hint).toHaveTextContent(/shipping cost/i);
  });

  it('calls out only the missing shipping cost when the email is on file', () => {
    render(<StepEmail row={{ ...row, step: 5 }} order={order('al@example.com')} />);
    const hint = screen.getByTestId('step-blockers');
    expect(hint).toHaveTextContent(/shipping cost/i);
    expect(hint).not.toHaveTextContent(/email address/i);
  });

  it('drops the hint once the cost is entered', () => {
    render(<StepEmail row={{ ...row, step: 5 }} order={order('al@example.com')} />);
    fireEvent.change(screen.getByPlaceholderText('42.75'), { target: { value: '42.75' } });
    expect(screen.queryByTestId('step-blockers')).toBeNull();
  });

  // R-0023 (Candace Chan): a replacement raised from a phone call has no email
  // on the order row, because the ticket it was copied from had none. The
  // address was on her customer record the whole time, and Step 5 refused to
  // send — telling the operator to add an email that already existed.
  it('sends to the customer record when the order row carries no email', () => {
    useOrderRecipientMock.mockReturnValue({
      email: 'garycandacechan@gmail.com', source: 'directory',
      nameMismatch: false, loading: false,
    });
    render(<StepEmail row={{ ...row, step: 5 }} order={order(null)} />);
    const hint = screen.getByTestId('step-blockers');
    expect(hint).toHaveTextContent(/shipping cost/i);
    expect(hint).not.toHaveTextContent(/email address/i);
  });

  it('names where an off-order address came from before it is sent', () => {
    useOrderRecipientMock.mockReturnValue({
      email: 'garycandacechan@gmail.com', source: 'directory',
      nameMismatch: false, loading: false,
    });
    render(<StepEmail row={{ ...row, step: 5 }} order={order(null)} />);
    expect(screen.getByText(/garycandacechan@gmail\.com/)).toHaveTextContent(/from the customer record/i);
  });

  it('keeps blocking when the linked customer record names someone else', () => {
    // orders.customer_id is set by a trigger that matches on name as well as
    // email, so a linked record can be the wrong person. Refuse rather than
    // email a stranger someone else's shipment.
    useOrderRecipientMock.mockReturnValue({
      email: null, source: null, nameMismatch: true, loading: false,
    });
    render(<StepEmail row={{ ...row, step: 5 }} order={order(null)} />);
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/names someone else/i);
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  it('names no blocker while the customer record is still being read', () => {
    useOrderRecipientMock.mockReturnValue({
      email: null, source: null, nameMismatch: false, loading: true,
    });
    render(<StepEmail row={{ ...row, step: 5 }} order={order(null)} />);
    const hint = screen.getByTestId('step-blockers');
    expect(hint).toHaveTextContent(/shipping cost/i);
    expect(hint).not.toHaveTextContent(/email address/i);
  });
});
