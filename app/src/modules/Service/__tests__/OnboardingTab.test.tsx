// FR-6: onboarding is the one call that is unambiguously WITH the primary
// user — they're the person being taught the machine. The purchaser still has
// to be visible, since they're who the account and warranty belong to.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

let ticketsToReturn: unknown[] = [];
let customersToReturn: unknown[] = [];
let lifecycleToReturn: unknown[] = [];
const sendFollowupMock = vi.fn(() => Promise.resolve());

vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useServiceTickets: vi.fn(() => ({ tickets: ticketsToReturn, loading: false })),
    useCustomerLifecycle: vi.fn(() => ({ rows: lifecycleToReturn, loading: false })),
    sendPostOnboardingFollowup: (...a: unknown[]) => sendFollowupMock(...(a as [])),
  };
});
vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return { ...actual, useCustomers: vi.fn(() => ({ customers: customersToReturn })) };
});
vi.mock('../../../lib/auth', () => ({
  useAuth: vi.fn(() => ({ user: { email: 'huayi@virgohome.io' } })),
}));
vi.mock('../TicketDetailPanel', () => ({ TicketDetailPanel: () => null }));

import { OnboardingTab } from '../OnboardingTab';

const mkTicket = (over: Record<string, unknown> = {}) => ({
  id: 'ob1', ticket_number: 'TKT-OB1', subject: 'onboarding call',
  category: 'onboarding', source: 'calendly', status: 'waiting_on_us',
  priority: 'normal', tags: [], topic: null,
  customer_id: 'c-chad', customer_name: 'Chad Wu', customer_email: 'chad@example.com',
  customer_phone: null, unit_serial: null,
  calendly_event_start: null,
  created_at: '2026-06-01T00:00:00Z', last_message_at: '2026-06-01T00:00:00Z',
  ...over,
});

const mkCustomer = (over: Record<string, unknown> = {}) => ({
  id: 'c-chad', full_name: 'Chad Wu', phone: null, email: 'chad@example.com',
  purchaser_id: null, primary_user_name: null, primary_user_phone: null,
  primary_user_email: null, primary_user_relationship: null,
  onboard_date: null, fu1_status: null, fu2_status: null,
  ...over,
});

describe('OnboardingTab — purchaser vs primary user', () => {
  beforeEach(() => {
    ticketsToReturn = []; customersToReturn = []; lifecycleToReturn = [];
    sendFollowupMock.mockClear();
  });

  it('headlines the primary user and still names the purchaser', () => {
    ticketsToReturn = [mkTicket()];
    customersToReturn = [mkCustomer({ primary_user_name: 'Sarah Wu' })];
    render(<OnboardingTab />);
    expect(screen.getAllByText(/Sarah Wu/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Chad Wu/).length).toBeGreaterThan(0);
  });

  it('shows a single plain name when nobody else is the primary user', () => {
    ticketsToReturn = [mkTicket()];
    customersToReturn = [mkCustomer()];
    render(<OnboardingTab />);
    expect(screen.getAllByText(/Chad Wu/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Primary user/)).toBeNull();
  });
});

describe('OnboardingTab — the follow-up email addresses the primary user', () => {
  beforeEach(() => {
    ticketsToReturn = []; customersToReturn = []; lifecycleToReturn = [];
    sendFollowupMock.mockClear();
  });

  const completedRow = {
    id: 'lc1', customer_id: 'c-chad', unit_serial: 'LL01-1',
    shipped_at: '2026-06-01T00:00:00Z', onboarding_status: 'completed',
    followup_email_sent_at: null, warranty_expires_at: null,
  };

  it('sends to the primary user own address and greets them by name', () => {
    lifecycleToReturn = [completedRow];
    customersToReturn = [mkCustomer({
      primary_user_name: 'Sarah Wu', primary_user_email: 'sarah@example.com',
    })];
    render(<OnboardingTab />);
    fireEvent.click(screen.getByText(/^All units \(/));
    fireEvent.click(screen.getAllByText('Send follow-up email')[0]);
    fireEvent.click(screen.getAllByText(/^Send$/)[0]);

    expect(sendFollowupMock).toHaveBeenCalled();
    const args = sendFollowupMock.mock.calls[0] as unknown[];
    expect(args[1]).toBe('sarah@example.com');
    expect((args[3] as { customer_first_name: string }).customer_first_name).toBe('Sarah');
  });

  it('falls back to the purchaser address when the primary user has none', () => {
    lifecycleToReturn = [completedRow];
    customersToReturn = [mkCustomer({ primary_user_name: 'Sarah Wu' })];
    render(<OnboardingTab />);
    fireEvent.click(screen.getByText(/^All units \(/));
    fireEvent.click(screen.getAllByText('Send follow-up email')[0]);
    fireEvent.click(screen.getAllByText(/^Send$/)[0]);

    const args = sendFollowupMock.mock.calls[0] as unknown[];
    expect(args[1]).toBe('chad@example.com');
    expect((args[3] as { customer_first_name: string }).customer_first_name).toBe('Sarah');
  });
});
