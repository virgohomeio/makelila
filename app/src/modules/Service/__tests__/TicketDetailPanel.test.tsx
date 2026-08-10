import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { ServiceTicket } from '../../../lib/service';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const updateTicketTagsMock = vi.fn(() => Promise.resolve());

vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    updateTicketTags: (...args: unknown[]) => updateTicketTagsMock(...(args as [])),
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

/** The buttons under a given section label ("Status" / "Tags"). Each section is
 *  `<div><div>{label}</div><div class=actionsRow>…buttons…</div></div>`. */
const sectionButtons = (label: string) =>
  within(screen.getByText(label).parentElement!).getAllByRole('button');

describe('TicketDetailPanel — Status row', () => {
  beforeEach(() => updateTicketTagsMock.mockClear());

  it('does not offer Queued for Replacement as a settable status', () => {
    render(<TicketDetailPanel ticket={mkTicket({ status: 'in_progress' })} onClose={() => {}} />);
    const labels = sectionButtons('Status').map(b => b.textContent ?? '');
    expect(labels.some(l => l.includes('Queued for Replacement'))).toBe(false);
    // The other six workflow states are still settable.
    expect(labels.some(l => l.includes('Action Needed'))).toBe(true);
    expect(labels.some(l => l.includes('On Hold'))).toBe(true);
  });
});

describe('TicketDetailPanel — Tags row', () => {
  beforeEach(() => updateTicketTagsMock.mockClear());

  it('offers Queued for Replacement as a tag', () => {
    render(<TicketDetailPanel ticket={mkTicket()} onClose={() => {}} />);
    const labels = sectionButtons('Tags').map(b => b.textContent ?? '');
    expect(labels.some(l => l.includes('Queued for Replacement'))).toBe(true);
  });

  it('adds a tag alongside an existing one — the reported bug', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement'] })}
      onClose={() => {}}
    />);
    const onHold = sectionButtons('Tags').find(b => (b.textContent ?? '').includes('On Hold'))!;
    fireEvent.click(onHold);
    expect(updateTicketTagsMock).toHaveBeenCalledWith('t1', ['queued_for_replacement', 'on_hold']);
  });

  it('toggles a tag off without disturbing the others', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['queued_for_replacement', 'on_hold'] })}
      onClose={() => {}}
    />);
    const onHold = sectionButtons('Tags').find(b => (b.textContent ?? '').includes('On Hold'))!;
    fireEvent.click(onHold);
    expect(updateTicketTagsMock).toHaveBeenCalledWith('t1', ['queued_for_replacement']);
  });

  it('stores tags in TICKET_STATUSES order regardless of click order', () => {
    render(<TicketDetailPanel
      ticket={mkTicket({ status: 'in_progress', tags: ['on_hold'] })}
      onClose={() => {}}
    />);
    const inProgress = sectionButtons('Tags').find(b => (b.textContent ?? '').includes('In Progress'))!;
    fireEvent.click(inProgress);
    // in_progress precedes on_hold in TICKET_STATUSES, so it leads.
    expect(updateTicketTagsMock).toHaveBeenCalledWith('t1', ['in_progress', 'on_hold']);
  });
});
