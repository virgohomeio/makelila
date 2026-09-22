import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { confirmLabelMock } = vi.hoisted(() => ({
  confirmLabelMock: vi.fn(() => Promise.resolve()),
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
  id: 'q-1', order_id: 'o-1', step: 3, assigned_serial: 'LL01-00000000358',
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

describe('StepLabel — why Confirm label is disabled', () => {
  beforeEach(() => confirmLabelMock.mockClear());

  it('names the missing Amazon tracking number on a US order', () => {
    render(<StepLabel row={{ ...row, carrier: 'UPS', tracking_num: '1Z2985EADK98125759' }} order={order('US')} />);

    expect(screen.getByRole('button', { name: /Confirm label/ })).toBeDisabled();
    expect(screen.getByTestId('label-blockers')).toHaveTextContent(
      /compost starter kit tracking number/i,
    );
  });

  it('names every missing field when nothing has been filled in', () => {
    render(<StepLabel row={row} order={order('US')} />);

    const blockers = screen.getByTestId('label-blockers');
    expect(blockers).toHaveTextContent(/carrier/i);
    expect(blockers).toHaveTextContent(/tracking number/i);
    expect(blockers).toHaveTextContent(/compost starter kit/i);
  });

  it('never asks a CA order for starter tracking', () => {
    render(<StepLabel row={{ ...row, carrier: 'UPS', tracking_num: '1Z999' }} order={order('CA')} />);

    expect(screen.getByRole('button', { name: /Confirm label/ })).toBeEnabled();
    expect(screen.queryByTestId('label-blockers')).toBeNull();
  });

  it('drops the hint as soon as the last field is filled in', () => {
    render(<StepLabel row={{ ...row, carrier: 'UPS', tracking_num: '1Z999' }} order={order('US')} />);

    expect(screen.getByTestId('label-blockers')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Amazon order details/i), {
      target: { value: 'TBA303011917292' },
    });
    expect(screen.queryByTestId('label-blockers')).toBeNull();
    expect(screen.getByRole('button', { name: /Confirm label/ })).toBeEnabled();
  });
});
