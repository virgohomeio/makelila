import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { dispositionMock, needInfoMock, updateNotesMock } = vi.hoisted(() => ({
  dispositionMock: vi.fn(() => Promise.resolve()),
  needInfoMock:    vi.fn(() => Promise.resolve()),
  updateNotesMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    disposition: dispositionMock,
    needInfo:    needInfoMock,
    updateNotes: updateNotesMock,
  };
});

import { Detail } from '../Detail';
import type { Order } from '../../../lib/orders';

const order: Order = {
  id: 'order-1',
  order_ref: '#3847',
  status: 'pending',
  customer_name: 'Keith Taitano',
  customer_email: 'k@example.com',
  customer_phone: null,
  quo_thread_url: null,
  address_line: '2847 SW Corbett',
  city: 'Portland', region_state: 'OR', country: 'US',
  address_verdict: 'house',
  freight_estimate_usd: 89.5, freight_threshold_usd: 200,
  total_usd: 1149,
  line_items: [{ sku: 'LL01', name: 'Lila 01', qty: 1, price_usd: 1149 }],
  notes: '',
  dispositioned_by: null, dispositioned_at: null,
  created_at: '2026-04-17T00:00:00Z',
};

describe('Detail', () => {
  beforeEach(() => {
    dispositionMock.mockClear();
    needInfoMock.mockClear();
    updateNotesMock.mockClear();
  });

  it('Confirm calls disposition with status=approved', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'approved');
    });
  });

  it('Flag requires a reason before Submit is enabled', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /flag/i }));
    const submit = screen.getByRole('button', { name: /submit/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/flagged/i), { target: { value: 'bad zip' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'flagged', 'bad zip');
    });
  });

  it('Hold allows empty reason', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /hold/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'held', '');
    });
  });

  it('Need Info calls needInfo (not disposition)', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /need info/i }));
    fireEvent.change(screen.getByPlaceholderText(/info is needed/i), { target: { value: 'driveway photo' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      expect(needInfoMock).toHaveBeenCalledWith(order, 'driveway photo');
      expect(dispositionMock).not.toHaveBeenCalled();
    });
  });

  it('Notes textarea fires updateNotes on blur, not on change', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/internal notes/i);
    fireEvent.change(textarea, { target: { value: 'needs follow-up' } });
    expect(updateNotesMock).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() => {
      expect(updateNotesMock).toHaveBeenCalledWith('order-1', 'needs follow-up');
    });
  });
});
