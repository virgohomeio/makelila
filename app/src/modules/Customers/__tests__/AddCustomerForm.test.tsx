// The Directory's manual "Add customer" drawer. The rules that matter here are
// the ones that stop a half-typed record reaching the table, and the one that
// keeps a rejected save recoverable — an operator who has typed nine fields and
// hit a duplicate email must not lose them.
// Spec: docs/superpowers/specs/2026-09-24-manual-add-customer-design.md
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return { ...actual, createCustomer: createMock };
});

import { AddCustomerForm } from '../AddCustomerForm';

beforeEach(() => { createMock.mockReset(); });

const saveBtn = () => screen.getByRole('button', { name: /^(Add customer|Adding)/ });

describe('AddCustomerForm', () => {
  it('will not save until a name is typed', () => {
    render(<AddCustomerForm onClose={() => {}} onCreated={() => {}} />);
    expect(saveBtn()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Gabriella' } });
    expect(saveBtn()).toBeEnabled();
  });

  it('accepts a last name alone as a name', () => {
    render(<AddCustomerForm onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: 'Washington' } });
    expect(saveBtn()).toBeEnabled();
  });

  it('sends every field it collected, and reports the new id', async () => {
    createMock.mockResolvedValue('new-id');
    const onCreated = vi.fn();
    render(<AddCustomerForm onClose={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Gabriella' } });
    fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: 'Hottya' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'gab@example.com' } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '519-555-0142' } });
    fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'Toronto' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-id'));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      first_name: 'Gabriella', last_name: 'Hottya',
      email: 'gab@example.com', phone: '519-555-0142', city: 'Toronto',
    }));
  });

  it('shows a rejected save and keeps what was typed', async () => {
    createMock.mockRejectedValue(new Error('Chad Smith already uses gab@example.com.'));
    const onCreated = vi.fn();
    render(<AddCustomerForm onClose={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Gabriella' } });
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'gab@example.com' } });
    fireEvent.click(saveBtn());

    expect(await screen.findByText(/Chad Smith already uses/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/First name/) as HTMLInputElement).value).toBe('Gabriella');
    expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe('gab@example.com');
  });

  it('closes on Cancel without writing anything', () => {
    const onClose = vi.fn();
    render(<AddCustomerForm onClose={onClose} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
