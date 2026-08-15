import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { useUsersMock, addMock, updateMock, removeMock } = vi.hoisted(() => ({
  useUsersMock: vi.fn(),
  addMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return {
    ...actual,
    useCustomerAdditionalUsers: useUsersMock,
    addCustomerAdditionalUser: addMock,
    updateCustomerAdditionalUser: updateMock,
    removeCustomerAdditionalUser: removeMock,
  };
});

import { AdditionalUsersSection } from '../AdditionalUsersSection';
import type { CustomerAdditionalUser } from '../../../lib/customers';

const sarah: CustomerAdditionalUser = {
  id: 'u1', customer_id: 'c1', full_name: 'Sarah Lockhart',
  phone: '416-555-0100', email: 'sarah@example.com',
  relationship: 'Spouse / partner',
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

const refresh = vi.fn();

/** Point the hook at a given list for the next render. */
function withUsers(users: CustomerAdditionalUser[], loading = false) {
  useUsersMock.mockReturnValue({ users, loading, refresh });
}

const openAddForm = () =>
  fireEvent.click(screen.getByRole('button', { name: '+ Add another user' }));

beforeEach(() => {
  useUsersMock.mockReset();
  addMock.mockReset().mockResolvedValue(sarah);
  updateMock.mockReset().mockResolvedValue(undefined);
  removeMock.mockReset().mockResolvedValue(undefined);
  refresh.mockReset().mockResolvedValue(undefined);
});

describe('AdditionalUsersSection', () => {
  it('says so when the household has no other users recorded', () => {
    withUsers([]);
    render(<AdditionalUsersSection customerId="c1" />);
    expect(screen.getByText('No other users recorded.')).toBeInTheDocument();
  });

  it('lists a saved user with their relationship and contact details', () => {
    withUsers([sarah]);
    render(<AdditionalUsersSection customerId="c1" />);

    expect(screen.getByText('Sarah Lockhart')).toBeInTheDocument();
    expect(screen.getByText(/Spouse \/ partner/)).toBeInTheDocument();
    expect(screen.getByText('416-555-0100 · sarah@example.com')).toBeInTheDocument();
  });

  it('requires a name before the user can be added', () => {
    withUsers([]);
    render(<AdditionalUsersSection customerId="c1" />);
    openAddForm();

    expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Household user full name'),
      { target: { value: 'Marc Lockhart' } });
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled();
  });

  it('adds a user with all four fields', async () => {
    withUsers([]);
    render(<AdditionalUsersSection customerId="c1" />);
    openAddForm();

    fireEvent.change(screen.getByLabelText('Household user full name'),
      { target: { value: 'Marc Lockhart' } });
    fireEvent.change(screen.getByLabelText('Household user phone'),
      { target: { value: '416-555-0199' } });
    fireEvent.change(screen.getByLabelText('Household user email'),
      { target: { value: 'marc@example.com' } });
    fireEvent.change(screen.getByLabelText("Household user's relationship to the purchaser"),
      { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => expect(addMock).toHaveBeenCalledWith('c1', {
      full_name: 'Marc Lockhart',
      phone: '416-555-0199',
      email: 'marc@example.com',
      relationship: 'Child',
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('stores the free text behind "Other…", not the sentinel', async () => {
    withUsers([]);
    render(<AdditionalUsersSection customerId="c1" />);
    openAddForm();

    fireEvent.change(screen.getByLabelText('Household user full name'),
      { target: { value: 'Dana' } });
    fireEvent.change(screen.getByLabelText("Household user's relationship to the purchaser"),
      { target: { value: 'Other…' } });
    fireEvent.change(screen.getByLabelText('Describe the relationship'),
      { target: { value: 'neighbour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => expect(addMock).toHaveBeenCalledWith('c1',
      expect.objectContaining({ relationship: 'neighbour' })));
  });

  it('edits an existing user in place', async () => {
    withUsers([sarah]);
    render(<AdditionalUsersSection customerId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    fireEvent.change(screen.getByLabelText('Household user phone'),
      { target: { value: '416-555-0222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('u1', 'c1',
      expect.objectContaining({ full_name: 'Sarah Lockhart', phone: '416-555-0222' })));
  });

  it('deletes nothing until the removal is confirmed', async () => {
    withUsers([sarah]);
    render(<AdditionalUsersSection customerId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText('Remove Sarah Lockhart?')).toBeInTheDocument();

    // Two "Remove" buttons now — the row's and the dialog's. Take the last.
    const confirm = screen.getAllByRole('button', { name: 'Remove' }).at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith('u1', 'c1', 'Sarah Lockhart'));
  });

  it('surfaces a failed write instead of silently dropping it', async () => {
    withUsers([]);
    addMock.mockRejectedValue(new Error('permission denied'));
    render(<AdditionalUsersSection customerId="c1" />);
    openAddForm();

    fireEvent.change(screen.getByLabelText('Household user full name'),
      { target: { value: 'Marc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));

    expect(await screen.findByText('permission denied')).toBeInTheDocument();
  });
});
