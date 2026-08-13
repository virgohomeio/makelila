import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { previewMock, renameMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  renameMock: vi.fn(),
}));

vi.mock('../../../lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/customers')>();
  return {
    ...actual,
    previewCustomerRename: previewMock,
    renameCustomer: renameMock,
  };
});

import { NameSection } from '../NameSection';
import type { Customer } from '../../../lib/customers';

const customer = {
  id: 'c1', first_name: 'Dhruv', last_name: 'Talwar', full_name: 'Dhruv Talwar',
} as Customer;

const preview = (over = {}) => ({
  old_name: 'Dhruv Talwar', new_name: 'Dhruv Talwer',
  ambiguous: false, updated: { service_tickets: 8, orders: 4 }, skipped: [],
  ...over,
});

/** Open the editor and change the last name. */
function startEditing() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Talwer' } });
}

beforeEach(() => {
  previewMock.mockReset();
  renameMock.mockReset();
});

describe('NameSection', () => {
  it('keeps Save disabled until a name actually changes', () => {
    render(<NameSection customer={customer} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Talwer' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('offers to add a name when the customer has none', () => {
    render(<NameSection
      customer={{ ...customer, first_name: null, last_name: null, full_name: '' } as Customer}
      onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add a name' })).toBeInTheDocument();
  });

  it('previews before writing, and writes nothing until confirmed', async () => {
    previewMock.mockResolvedValue(preview());
    render(<NameSection customer={customer} onChanged={vi.fn()} />);
    startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/This also updates the name on 12 related records/);
    expect(screen.getByText('service tickets')).toBeInTheDocument();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('applies the rename on confirm', async () => {
    previewMock.mockResolvedValue(preview());
    renameMock.mockResolvedValue(preview());
    const onChanged = vi.fn();
    render(<NameSection customer={customer} onChanged={onChanged} />);
    startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('c1', 'Dhruv', 'Talwer'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('writes nothing when the confirm is cancelled', async () => {
    previewMock.mockResolvedValue(preview());
    render(<NameSection customer={customer} onChanged={vi.fn()} />);
    startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Rename' });

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1]);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument());
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('warns about rows left behind when the old name is ambiguous', async () => {
    previewMock.mockResolvedValue(preview({
      ambiguous: true,
      skipped: [{ table: 'units', id: 'LILA-0142', label: 'shipped 2026-03-11' }],
    }));
    render(<NameSection customer={customer} onChanged={vi.fn()} />);
    startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/1 unlinked record is left unchanged/);
    expect(screen.getByText(/LILA-0142/)).toBeInTheDocument();
    expect(screen.getByText(/Another customer also goes by/)).toBeInTheDocument();
  });

  it('shows a database error instead of a confirm dialog', async () => {
    previewMock.mockRejectedValue(new Error('A customer needs at least a first or last name.'));
    render(<NameSection customer={customer} onChanged={vi.fn()} />);
    startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('A customer needs at least a first or last name.');
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });
});
