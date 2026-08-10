import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { ServiceTicket } from '../../../lib/service';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const setTicketStatusesMock = vi.fn(() => Promise.resolve());

vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    setTicketStatuses: (...args: unknown[]) => setTicketStatusesMock(...(args as [])),
    useCustomerLifecycle: vi.fn(() => ({ row: null, loading: false })),
    useTicketMessages: vi.fn(() => ({ messages: [], loading: false })),
    useClassificationLog: vi.fn(() => ({ entries: [], loading: false })),
  };
});
vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return { ...actual, useCustomers: vi.fn(() => ({ customers: [] })) };
});
vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return { ...actual, useReplacementSummary: vi.fn(() => ({ summary: null, loading: false })) };
});
vi.mock('../../../lib/auth', () => ({
  useAuth: vi.fn(() => ({ user: { email: 'huayi@virgohome.io' } })),
}));
// Child panels each open their own Supabase subscriptions; stub them out so
// this suite only exercises the Status / Tags rows.
vi.mock('../TicketNotes', () => ({ TicketNotes: () => null }));
vi.mock('../TicketActionItems', () => ({ TicketActionItems: () => null }));
vi.mock('../AttachmentStrip', () => ({ AttachmentStrip: () => null }));
vi.mock('../../../components/DeviceContextHeader', () => ({ DeviceContextHeader: () => null }));

import { TicketDetailPanel } from '../TicketDetailPanel';

function mkTicket(partial: Partial<ServiceTicket> = {}): ServiceTicket {
  return {
    id: 't1',
    ticket_number: 'TKT-1',
    category: 'support',
    source: 'gmail',
    status: 'waiting_on_us',
    priority: 'normal',
    tags: [],
    customer_id: null, customer_name: 'Alice', customer_email: 'a@x.com',
    customer_phone: null, unit_serial: null, order_ref: null,
    subject: 'help me', description: null, internal_notes: null,
    defect_category: null, parts_needed: null,
    calendly_event_uri: null, calendly_event_start: null, calendly_host_email: null,
    hubspot_ticket_id: null, fulfillment_queue_id: null,
    owner_email: null, resolved_at: null, closed_at: null,
    replacement_order_id: null,
    diagnosis_link_sent_at: null, diag_cohost_invited_at: null,
    google_calendar_event_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    gmail_thread_id: null, gmail_account: null,
    topic: null, summary: null, suggested_next_action: null,
    last_classified_at: null, classification_confidence: null,
    message_count: 1,
    first_message_at: '2026-06-01T00:00:00Z',
    last_message_at: '2026-06-01T00:00:00Z',
    is_manually_overridden: false,
    issue_area: null,
    kind: 'ticket',
    inbox_disposition: null,
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
  } as ServiceTicket;
}

/** The buttons under the "Status" section label. The section is
 *  `<div><div>Status</div><div class=actionsRow>…buttons…</div></div>`. */
const statusButtons = () =>
  within(screen.getByText('Status').parentElement!).getAllByRole('button');
const statusButton = (label: string) =>
  statusButtons().find(b => (b.textContent ?? '').includes(label))!;

describe('TicketDetailPanel — Status is multi-select', () => {
  beforeEach(() => setTicketStatusesMock.mockClear());

  it('offers every status, including Queued for Replacement, in ONE row', () => {
    render(<TicketDetailPanel ticket={mkTicket()} onClose={() => {}} />);
    const labels = statusButtons().map(b => b.textContent ?? '');
    for (const expected of [
      'Action Needed', 'In Progress', 'Awaiting Customer Response',
      'Queued for Replacement', 'Call Scheduled', 'On Hold', 'Complete',
    ]) {
      expect(labels.some(l => l.includes(expected))).toBe(true);
    }
    // There is no separate Tags control — statuses ARE the tags.
    expect(screen.queryByText('Tags')).toBeNull();
  });

  it('checks every status the ticket holds, from status + tags', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    expect(statusButton('In Progress').textContent).toContain('✓');
    expect(statusButton('Queued for Replacement').textContent).toContain('✓');
    expect(statusButton('On Hold').textContent).not.toContain('✓');
  });

  it('adds a status alongside an existing one — the reported bug', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    fireEvent.click(statusButton('On Hold'));
    expect(setTicketStatusesMock).toHaveBeenCalledWith(
      't1', ['in_progress', 'queued_for_replacement', 'on_hold'],
    );
  });

  it('removes a status without disturbing the others', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement', 'on_hold'] })}
      onClose={() => {}}
    />);
    fireEvent.click(statusButton('On Hold'));
    expect(setTicketStatusesMock).toHaveBeenCalledWith(
      't1', ['in_progress', 'queued_for_replacement'],
    );
  });

  it('keeps the auto-applied replacement status when another is added', () => {
    // The replacement workflow tags the ticket; the operator then marks it
    // Awaiting Customer Response. Both must survive.
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'waiting_on_us', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    fireEvent.click(statusButton('Awaiting Customer Response'));
    const [, next] = setTicketStatusesMock.mock.calls[0] as unknown as [string, string[]];
    expect(next).toContain('queued_for_replacement');
    expect(next).toContain('waiting_on_customer');
  });

  it('Complete is exclusive — selecting it clears the other statuses', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    fireEvent.click(statusButton('Complete'));
    expect(setTicketStatusesMock).toHaveBeenCalledWith('t1', ['closed']);
  });

  it('deselecting Complete reopens the ticket', () => {
    render(<TicketDetailPanel ticket={mkTicket({ status: 'closed' })} onClose={() => {}} />);
    fireEvent.click(statusButton('Complete'));
    // Empty set — setTicketStatuses falls back to Action Needed.
    expect(setTicketStatusesMock).toHaveBeenCalledWith('t1', []);
  });
});
