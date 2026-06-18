import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InboxTab } from '../InboxTab';
import type { ServiceTicket } from '../../../lib/service';

function mkConv(partial: Partial<ServiceTicket> & { id: string }): ServiceTicket {
  return {
    ticket_number: 'CONV-1',
    category: 'support',
    source: 'quo',
    status: 'waiting_on_us',
    priority: 'normal',
    customer_id: null, customer_name: null, customer_email: null,
    customer_phone: '+15551234567', unit_serial: null, order_ref: null,
    subject: 'test convo', description: 'hello', internal_notes: null,
    defect_category: null, parts_needed: null,
    calendly_event_uri: null, calendly_event_start: null, calendly_host_email: null,
    hubspot_ticket_id: null, fulfillment_queue_id: null,
    owner_email: null, resolved_at: null, closed_at: null,
    created_at: '2026-05-28T00:00:00Z', updated_at: '2026-05-28T00:00:00Z',
    gmail_thread_id: null, gmail_account: null,
    topic: null, summary: null, suggested_next_action: null,
    last_classified_at: null, classification_confidence: null,
    message_count: 1,
    first_message_at: '2026-05-28T00:00:00Z',
    last_message_at: '2026-05-28T00:00:00Z',
    is_manually_overridden: false,
    issue_area: null,
    kind: 'conversation',
    inbox_disposition: null,
    replacement_order_id: null,
    diagnosis_link_sent_at: null,
    diag_cohost_invited_at: null,
    diagnosis_followup_done_at: null,
    google_calendar_event_id: null,
    sla_policy_id: null,
    first_response_due_at: null,
    resolution_due_at: null,
    first_responded_at: null,
    sla_resolved_at: null,
    sla_status: null,
    root_cause: null,
    linear_issue_url: null,
    github_issue_url: null,
    engineering_resolved_at: null,
    ...partial,
  };
}

const { setDispositionMock } = vi.hoisted(() => ({
  setDispositionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useInbox: vi.fn(() => ({
      rows: [
        mkConv({ id: 'c1', customer_name: 'Alice', description: 'I need help' }),
        mkConv({ id: 'c2', source: 'gmail', subject: 'sales inquiry', description: 'Want a demo' }),
      ],
      loading: false,
    })),
    setInboxDisposition: setDispositionMock,
    SOURCE_LABEL: actual.SOURCE_LABEL,
  };
});

beforeEach(() => { setDispositionMock.mockClear(); });

describe('InboxTab', () => {
  it('renders one row per conversation with channel icon + customer', () => {
    render(<InboxTab />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/sales inquiry/i)).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking Dismiss calls setInboxDisposition with dismissed', async () => {
    render(<InboxTab />);
    const table = screen.getByRole('table');
    const buttons = within(table).getAllByRole('button', { name: /^dismiss$/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'dismissed');
  });

  it('clicking Sales calls setInboxDisposition with sales', async () => {
    render(<InboxTab />);
    const table = screen.getByRole('table');
    const buttons = within(table).getAllByRole('button', { name: /^sales$/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'sales');
  });

  it('clicking Follow-up calls setInboxDisposition with follow_up', async () => {
    render(<InboxTab />);
    const table = screen.getByRole('table');
    const buttons = within(table).getAllByRole('button', { name: /^follow-up$/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'follow_up');
  });
});
