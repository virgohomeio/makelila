import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceTicket } from '../../../lib/service';
import type { CustomerGroup } from '../ticketGrouping';

vi.mock('../../../components/DeviceContextHeader', () => ({ DeviceContextHeader: () => null }));

import { CustomerProfilePanel } from '../CustomerProfilePanel';

const mkTicket = (partial: Partial<ServiceTicket> & { id: string }) => ({
  ticket_number: 'TKT-1', category: 'support', source: 'gmail',
  status: 'waiting_on_us', priority: 'normal', tags: [],
  customer_id: 'c1', customer_name: 'Alice', customer_email: 'a@x.com',
  subject: 'help me', topic: null,
  created_at: '2026-06-01T00:00:00Z', last_message_at: '2026-06-01T00:00:00Z',
  ...partial,
}) as ServiceTicket;

const mkGroup = (tickets: ServiceTicket[]) => ({
  customerId: 'c1', customerName: 'Alice', customerEmail: 'a@x.com',
  tickets, total: tickets.length, openCount: tickets.length,
  lastActivity: '2026-06-01T00:00:00Z', rollupStatus: 'waiting_on_us',
}) as CustomerGroup;

const renderPanel = (tickets: ServiceTicket[]) => render(
  <CustomerProfilePanel
    group={mkGroup(tickets)}
    customer={undefined}
    onClose={() => {}}
    onOpenTicket={() => {}}
    onAddTicket={() => {}}
  />,
);

describe('CustomerProfilePanel status pills', () => {
  // setTicketStatuses stores the primary in BOTH `status` and `tags`. Rendering
  // those as two separate lists printed the primary twice — the reported bug.
  it('prints the primary status once when it also appears in tags', () => {
    renderPanel([mkTicket({
      id: 't1',
      status: 'waiting_on_customer',
      tags: ['waiting_on_customer', 'queued_for_replacement'],
    })]);
    expect(screen.getAllByText('Awaiting Customer Response')).toHaveLength(1);
    expect(screen.getAllByText('Queued for Replacement')).toHaveLength(1);
  });

  it('shows every status a ticket holds', () => {
    renderPanel([mkTicket({
      id: 't1', status: 'in_progress', tags: ['in_progress', 'on_hold'],
    })]);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('On Hold')).toBeInTheDocument();
  });

  it('still renders rows written before multi-select (empty tags)', () => {
    renderPanel([mkTicket({ id: 't1', status: 'on_hold', tags: [] })]);
    expect(screen.getAllByText('On Hold')).toHaveLength(1);
  });
});
