// Raising a support ticket for a colleague. The dialog used to demand a
// customer, so the only way to ticket a team member's LILA Pro was to give
// them a customer record — which is how four staff ended up in
// public.customers, counted as customers everywhere.
// Spec: docs/superpowers/specs/2026-09-24-team-member-support-tickets-design.md
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { createTicketMock, setHolderMock, unitsMock, rosterMock } = vi.hoisted(() => ({
  createTicketMock: vi.fn(),
  setHolderMock: vi.fn(),
  unitsMock: vi.fn(),
  rosterMock: vi.fn(),
}));

vi.mock('../../../lib/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/service')>();
  return { ...actual, createTicket: createTicketMock };
});
vi.mock('../../../lib/stock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/stock')>();
  return { ...actual, useUnits: unitsMock };
});
vi.mock('../../../lib/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/team')>();
  return { ...actual, useTeamRoster: rosterMock, setTeamUnitHolder: setHolderMock };
});
vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return { ...actual, syncCustomersFromHubspot: vi.fn() };
});

import { NewTicketModal } from '../NewTicketModal';
import type { Customer } from '../../../lib/customers';
import type { Unit } from '../../../lib/stock';

const customers = [
  { id: 'c1', full_name: 'Gabriella Hottya', email: 'gab@example.com', phone: null },
] as Customer[];

const unit = (over: Partial<Unit>) => ({
  serial: 'LL01-00000000208', batch: 'P50N', status: 'team-test',
  customer_name: null, customer_id: null, is_team_test: true, shipped_at: null,
  ...over,
} as Unit);

const units = [
  // Huayi's, with nobody recorded against it yet.
  unit({ serial: 'LL01-00000000208' }),
  // Junaid's, already carrying his name with an operator suffix.
  unit({ serial: 'LL01-00000000341', status: 'shipped', customer_name: 'Junaid Siddiqui - Office Machine' }),
  // An ordinary customer machine, which must never appear in the team picker.
  unit({ serial: 'LL01-00000000999', status: 'shipped', is_team_test: false, customer_name: 'Gabriella Hottya' }),
];

const roster = [
  { email: 'huayi@virgohome.io', display_name: 'Huayi' },
  { email: 'junaid@virgohome.io', display_name: 'Junaid' },
];

beforeEach(() => {
  createTicketMock.mockReset().mockResolvedValue({ id: 't1', ticket_number: 'T-1' });
  setHolderMock.mockReset().mockResolvedValue(undefined);
  unitsMock.mockReturnValue({ units, loading: false });
  rosterMock.mockReturnValue({
    members: roster,
    emails: new Set(roster.map(m => m.email)),
    loading: false,
  });
});

const render_ = () =>
  render(<NewTicketModal customers={customers} onClose={() => {}} onCreated={() => {}} />);

const typeSubject = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText(/Type a name, email/), { target: { value: v } });

const createBtn = () => screen.getByRole('button', { name: /Create ticket|Creating/ });

describe('NewTicketModal — team members', () => {
  it('offers a team member alongside customers and lets Create proceed', async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Fan rattling' } });
    expect(createBtn()).toBeDisabled();

    typeSubject('huayi');
    fireEvent.click(await screen.findByRole('button', { name: /Huayi/ }));
    expect(createBtn()).toBeEnabled();
  });

  it('writes the ticket with no customer_id, the roster email and is_team', async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Fan rattling' } });
    typeSubject('huayi');
    fireEvent.click(await screen.findByRole('button', { name: /Huayi/ }));
    fireEvent.click(createBtn());

    await waitFor(() => expect(createTicketMock).toHaveBeenCalled());
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: null,
      customer_name: 'Huayi',
      customer_email: 'huayi@virgohome.io',
      is_team: true,
    }));
  });

  it("auto-fills a team member's unit when one already records them", async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Lid stuck' } });
    typeSubject('junaid');
    fireEvent.click(await screen.findByRole('button', { name: /Junaid/ }));

    await waitFor(() =>
      expect((screen.getByLabelText(/Unit serial/) as HTMLSelectElement).value)
        .toBe('LL01-00000000341'));
  });

  it('offers unheld team units, and records the holder when one is picked', async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Fan rattling' } });
    typeSubject('huayi');
    fireEvent.click(await screen.findByRole('button', { name: /Huayi/ }));

    const serial = screen.getByLabelText(/Unit serial/) as HTMLSelectElement;
    // The customer's machine is not the team's to pick from.
    expect(serial.textContent).not.toContain('LL01-00000000999');
    fireEvent.change(serial, { target: { value: 'LL01-00000000208' } });
    fireEvent.click(createBtn());

    await waitFor(() => expect(createTicketMock).toHaveBeenCalled());
    expect(setHolderMock).toHaveBeenCalledWith('LL01-00000000208', 'Huayi');
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
      unit_serial: 'LL01-00000000208',
    }));
  });

  it('does not re-record a holder that is already on the unit', async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Lid stuck' } });
    typeSubject('junaid');
    fireEvent.click(await screen.findByRole('button', { name: /Junaid/ }));
    await waitFor(() =>
      expect((screen.getByLabelText(/Unit serial/) as HTMLSelectElement).value)
        .toBe('LL01-00000000341'));
    fireEvent.click(createBtn());

    await waitFor(() => expect(createTicketMock).toHaveBeenCalled());
    expect(setHolderMock).not.toHaveBeenCalled();
  });

  it('still creates a customer ticket the old way', async () => {
    render_();
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Wont start' } });
    typeSubject('gab');
    fireEvent.click(await screen.findByRole('button', { name: /Gabriella/ }));
    fireEvent.click(createBtn());

    await waitFor(() => expect(createTicketMock).toHaveBeenCalled());
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'c1',
      customer_name: 'Gabriella Hottya',
    }));
    expect(createTicketMock.mock.calls[0][0].is_team).toBeFalsy();
  });
});
