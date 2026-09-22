import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { assignUnitMock, useUnitsMock } = vi.hoisted(() => ({
  assignUnitMock: vi.fn(() => Promise.resolve()),
  useUnitsMock: vi.fn(),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return { ...actual, assignUnit: assignUnitMock, toggleDockCheck: vi.fn(() => Promise.resolve()) };
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
  id: 'q-1', order_id: 'o-1', step: 1, assigned_serial: null,
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

describe('StepAssign — why Confirm is disabled', () => {
  beforeEach(() => {
    assignUnitMock.mockClear();
    useUnitsMock.mockReturnValue({ units: [readyUnit], loading: false });
  });

  it('asks the operator to pick a unit when none is selected', () => {
    render(<StepAssign row={row} />);
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDisabled();
    expect(screen.getByTestId('step-blockers')).toHaveTextContent(/a unit picked/i);
  });

  it('clears the hint once a unit is picked', () => {
    render(<StepAssign row={row} />);
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
});
