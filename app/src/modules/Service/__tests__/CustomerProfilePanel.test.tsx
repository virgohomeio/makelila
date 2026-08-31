import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceTicket } from '../../../lib/service';
import type { CustomerGroup } from '../ticketGrouping';

// Rendered as a marker rather than null: the Support tab's profile panel must
// NOT show the device-context chip strip, and a null mock cannot tell the
// difference between "removed" and "rendered empty".
vi.mock('../../../components/DeviceContextHeader', () => ({
  DeviceContextHeader: () => <div data-testid="device-context-header" />,
}));

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

describe('CustomerProfilePanel device context', () => {
  it('does not render the device-context chip strip', () => {
    const group = mkGroup([mkTicket({ id: 't1' })]);
    render(
      <CustomerProfilePanel
        group={group}
        customer={undefined}
        onClose={() => {}}
        onOpenTicket={() => {}}
        onAddTicket={() => {}}
      />,
    );
    expect(screen.queryByTestId('device-context-header')).toBeNull();
  });
});

// FR-6: the profile header is the biggest statement of "who this is". It has
// to name the machine's primary user, and it must not thereby erase the
// purchaser — they hold the warranty.
describe('CustomerProfilePanel — purchaser vs primary user', () => {
  const parties = (over: Record<string, unknown> = {}) => ({
    displayName: 'Sarah Wu', purchaserName: 'Chad Wu', split: true,
    relationship: null, phone: null, email: null, ...over,
  });

  it('headlines the primary user and still names the purchaser', () => {
    render(
      <CustomerProfilePanel
        group={mkGroup([mkTicket({ id: 't1' })])}
        customer={undefined}
        parties={parties()}
        onClose={() => {}}
        onOpenTicket={() => {}}
        onAddTicket={() => {}}
      />,
    );
    expect(screen.getByText('Sarah Wu')).toBeTruthy();
    expect(screen.getByText(/Chad Wu/)).toBeTruthy();
    expect(screen.getByText(/Primary user/)).toBeTruthy();
  });

  it('falls back to the group name when no parties are resolved', () => {
    render(
      <CustomerProfilePanel
        group={mkGroup([mkTicket({ id: 't1' })])}
        customer={undefined}
        onClose={() => {}}
        onOpenTicket={() => {}}
        onAddTicket={() => {}}
      />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });
});
