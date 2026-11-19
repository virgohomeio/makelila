// FR-6: the owner board is one of the Support tab's three views. It has to
// name the same person the list view does, or the tab contradicts itself.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceTicket } from '../../../lib/service';
import { OwnerKanban } from '../OwnerKanban';

const mkTicket = (id: string, extra: Partial<ServiceTicket> = {}) => ({
  id, ticket_number: `TKT-${id}`, subject: 'help', status: 'waiting_on_us',
  priority: 'normal', customer_name: 'Alice', customer_email: 'a@x.com',
  customer_id: null, customer_phone: null,
  category: 'support', source: 'gmail', tags: [], topic: null,
  owner_email: 'reina@virgohome.io',
  created_at: '2026-06-01T00:00:00Z', last_message_at: '2026-06-01T00:00:00Z',
  ...extra,
}) as ServiceTicket;

describe('OwnerKanban — purchaser vs primary user', () => {
  it('names the primary user and keeps the purchaser on the card', () => {
    render(
      <OwnerKanban
        tickets={[mkTicket('t1', { customer_id: 'c-chad', customer_name: 'Chad Wu' })]}
        currentUserEmail="huayi@virgohome.io"
        onSelectTicket={() => {}}
        partiesFor={() => ({
          displayName: 'Sarah Wu', purchaserName: 'Chad Wu', split: true,
          relationship: null, phone: null, email: null,
        })}
      />,
    );
    expect(screen.getByText(/Sarah Wu/)).toBeTruthy();
    expect(screen.getByText(/Chad Wu/)).toBeTruthy();
  });

  it('falls back to the ticket snapshot with no resolver supplied', () => {
    render(
      <OwnerKanban
        tickets={[mkTicket('t1')]}
        currentUserEmail="huayi@virgohome.io"
        onSelectTicket={() => {}}
      />,
    );
    expect(screen.getByText(/Alice/)).toBeTruthy();
  });
});
