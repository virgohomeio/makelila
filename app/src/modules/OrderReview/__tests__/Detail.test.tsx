import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { dispositionMock, needInfoMock, addOrderNoteMock, useOrderNotesMock } = vi.hoisted(() => ({
  dispositionMock:  vi.fn(() => Promise.resolve()),
  needInfoMock:     vi.fn(() => Promise.resolve()),
  addOrderNoteMock: vi.fn(() => Promise.resolve()),
  useOrderNotesMock: vi.fn(() => ({ notes: [], loading: false })),
}));

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    disposition:    dispositionMock,
    needInfo:       needInfoMock,
    addOrderNote:   addOrderNoteMock,
    useOrderNotes:  useOrderNotesMock,
  };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    profile: { id: 'u1', display_name: 'Test User', role: 'member' },
    user: { id: 'u1', email: 'test@virgohome.io' },
    session: null,
    loading: false,
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { Detail } from '../Detail';
import type { Order } from '../../../lib/orders';

const order: Order = {
  id: 'order-1',
  order_ref: '#3847',
  status: 'pending',
  customer_name: 'Keith Taitano',
  customer_email: 'k@example.com',
  customer_phone: '+1-555-0100',
  quo_thread_url: null,
  address_line: '2847 SW Corbett',
  city: 'Portland', region_state: 'OR', country: 'US',
  address_verdict: 'house',
  freight_estimate_usd: 89.5, freight_threshold_usd: 200,
  total_usd: 1149,
  line_items: [{ sku: 'LL01', name: 'Lila 01', qty: 1, price_usd: 1149 }],
  sales_confirmed_fit: false,
  dispositioned_by: null, dispositioned_at: null,
  created_at: '2026-04-17T00:00:00Z',
};

describe('Detail', () => {
  beforeEach(() => {
    dispositionMock.mockClear();
    needInfoMock.mockClear();
    addOrderNoteMock.mockClear();
  });

  it('Confirm calls disposition with status=approved', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'approved');
    });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
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
    expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'Flagged: bad zip');
  });

  it('Hold allows empty reason', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /hold/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => {
      expect(dispositionMock).toHaveBeenCalledWith(order, 'held', '');
    });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
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
    expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'Need info: driveway photo');
  });

  it('Add note button fires addOrderNote with the current user name + body', async () => {
    render(<Detail order={order} onAfterDisposition={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/add a review note/i);
    fireEvent.change(textarea, { target: { value: 'first note' } });
    expect(addOrderNoteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /add note/i }));
    await waitFor(() => {
      expect(addOrderNoteMock).toHaveBeenCalledWith('order-1', 'Test User', 'first note');
    });
  });
});
