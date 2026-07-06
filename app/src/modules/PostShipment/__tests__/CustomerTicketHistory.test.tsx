import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomerTicketHistory } from '../RefundsTab';
import type { ServiceTicket } from '../../../lib/service';

function ticket(over: Partial<ServiceTicket> & { id: string; ticket_number: string }): ServiceTicket {
  return {
    category: 'support', source: 'gmail', status: 'waiting_on_us', priority: 'normal',
    customer_id: null, customer_name: 'Jeff', customer_email: 'jeff@example.com',
    customer_phone: null, unit_serial: null, order_ref: null,
    subject: over.subject ?? 'Composter not working', description: null, internal_notes: null,
    defect_category: null, parts_needed: null, calendly_event_uri: null, calendly_event_start: null,
    calendly_host_email: null, hubspot_ticket_id: null, fulfillment_queue_id: null, owner_email: null,
    resolved_at: null, closed_at: null, replacement_order_id: null, kind: 'ticket',
    inbox_disposition: null, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    gmail_thread_id: null, gmail_account: null, topic: null, summary: null,
    suggested_next_action: null, last_classified_at: null, classification_confidence: null,
    message_count: 0, first_message_at: null, last_message_at: null, is_manually_overridden: false,
    issue_area: null, root_cause: null, diagnosis_link_sent_at: null, diag_cohost_invited_at: null,
    google_calendar_event_id: null, sla_policy_id: null, first_response_due_at: null,
    resolution_due_at: null, first_responded_at: null, sla_resolved_at: null, sla_status: null,
    linear_issue_url: null, github_issue_url: null, engineering_resolved_at: null,
    ...over,
  };
}

const tickets = [
  ticket({ id: 't1', ticket_number: 'TCK-001', subject: 'Composter not working' }),
  ticket({ id: 't2', ticket_number: 'TCK-002', subject: 'Odor issue' }),
];

describe('CustomerTicketHistory', () => {
  it('is collapsed by default and shows the count', () => {
    render(<CustomerTicketHistory tickets={tickets} onOpenTicket={() => {}} />);
    expect(screen.getByText(/Ticket history \(2\)/)).toBeTruthy();
    expect(screen.queryByText('TCK-001')).toBeNull(); // list hidden
  });

  it('expands the list when the toggle is clicked', () => {
    render(<CustomerTicketHistory tickets={tickets} onOpenTicket={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Ticket history/ }));
    expect(screen.getByText('TCK-001')).toBeTruthy();
    expect(screen.getByText('TCK-002')).toBeTruthy();
  });

  it('does NOT bubble the toggle click to a surrounding card handler', () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <CustomerTicketHistory tickets={tickets} onOpenTicket={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ticket history/ }));
    expect(screen.getByText('TCK-001')).toBeTruthy(); // still expands
    expect(onCardClick).not.toHaveBeenCalled();       // card not selected
  });

  it('opens a ticket when a row is clicked', () => {
    const onOpenTicket = vi.fn();
    render(<CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />);
    fireEvent.click(screen.getByText('Odor issue'));
    expect(onOpenTicket).toHaveBeenCalledWith('t2');
  });

  it('with defaultOpen, shows the tickets immediately (no click needed)', () => {
    render(<CustomerTicketHistory tickets={tickets} onOpenTicket={() => {}} defaultOpen />);
    expect(screen.getByText('TCK-001')).toBeTruthy();
    expect(screen.getByText('TCK-002')).toBeTruthy();
  });

  it('does not crash on an unknown ticket status', () => {
    const weird = [ticket({ id: 't9', ticket_number: 'TCK-009', status: 'some_new_state' as never })];
    render(<CustomerTicketHistory tickets={weird} onOpenTicket={() => {}} defaultOpen />);
    expect(screen.getByText('TCK-009')).toBeTruthy();
    expect(screen.getByText('some_new_state')).toBeTruthy(); // neutral fallback badge
  });
});
