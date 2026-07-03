import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { useLovelyUsersMock, approveMock, fetchCtxMock, addSerialAndVerifyMock, logActionMock } =
  vi.hoisted(() => ({
    useLovelyUsersMock: vi.fn(),
    approveMock: vi.fn(),
    fetchCtxMock: vi.fn(),
    addSerialAndVerifyMock: vi.fn(),
    logActionMock: vi.fn(),
  }));

vi.mock('../../lib/lovely', () => ({
  useLovelyUsers: useLovelyUsersMock,
  approveLovelyUser: approveMock,
}));
vi.mock('../../lib/lovelyVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lovelyVerification')>()),
  fetchVerificationContext: fetchCtxMock,
  addSerialAndVerify: addSerialAndVerifyMock,
}));
vi.mock('../../lib/activityLog', () => ({ logAction: logActionMock }));

import { VerificationTab } from './VerificationTab';

const baseUser = {
  id: 'u1', email: 'jane@x.com', first_name: 'Jane', last_name: 'Doe',
  serial_number: 'LL01-00000000307', onboarding_step: 'pairing',
  is_verified: false, verified_at: null, mailing_list: null,
  last_login_at: null, login_count: null,
  created_at: '2026-07-01T00:00:00Z', updated_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useLovelyUsersMock.mockReturnValue({
    users: [baseUser], loading: false, error: null, refetch: vi.fn(),
  });
});

describe('VerificationTab diagnosis', () => {
  it('shows a mismatch badge and the fix button when the serial is missing from the customer', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: ['LL01-00000000111'] }],
      serialOwners: [],
    });
    render(<VerificationTab />);
    expect(await screen.findByText('Serial mismatch')).toBeTruthy();
    expect(screen.getByRole('button', { name: /add serial \+ verify/i })).toBeTruthy();
  });

  it('runs the fix on click', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: [] }],
      serialOwners: [],
    });
    addSerialAndVerifyMock.mockResolvedValue(undefined);
    render(<VerificationTab />);
    fireEvent.click(await screen.findByRole('button', { name: /add serial \+ verify/i }));
    await waitFor(() =>
      expect(addSerialAndVerifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u1' }), 'c1',
      ));
  });

  it('suppresses the fix button when the serial belongs to a different customer, but keeps Approve', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: [] }],
      serialOwners: [{ id: 'c9', email: 'someone-else@x.com', full_name: 'Someone Else', serials: ['LL01-00000000307'] }],
    });
    render(<VerificationTab />);
    expect(await screen.findByText('Serial mismatch')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add serial \+ verify/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
  });

  it('shows will-auto-verify with Approve only', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: ['LL01-00000000307'] }],
      serialOwners: [],
    });
    render(<VerificationTab />);
    expect(await screen.findByText('Will auto-verify')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add serial \+ verify/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
  });

  it('shows no-customer and degrades to Approve when diagnosis fetch fails', async () => {
    fetchCtxMock.mockRejectedValue(new Error('offline'));
    render(<VerificationTab />);
    // Appears twice (error bar + per-row cell), so findAllByText, not findByText.
    expect((await screen.findAllByText(/diagnosis unavailable/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
  });

  it('does not flash stale "No customer"/"No serial" verdicts while users finish loading and the context fetch is in flight', async () => {
    // First render: hook still loading with no users yet (initial mount state).
    useLovelyUsersMock.mockReturnValue({
      users: [], loading: true, error: null, refetch: vi.fn(),
    });
    let resolveCtx: (value: {
      customersByEmail: { id: string; email: string; full_name: string; serials: string[] }[];
      serialOwners: unknown[];
    }) => void = () => {};
    fetchCtxMock.mockImplementation(
      () => new Promise(resolve => { resolveCtx = resolve; }),
    );

    const { rerender } = render(<VerificationTab />);
    expect(screen.getByText(/loading/i)).toBeTruthy();

    // Hook finishes loading and returns the pending user; the context fetch
    // is still in flight, so the row must show the placeholder, not a stale
    // "No customer"/"No serial" verdict from an empty context.
    useLovelyUsersMock.mockReturnValue({
      users: [baseUser], loading: false, error: null, refetch: vi.fn(),
    });
    rerender(<VerificationTab />);

    expect(screen.queryByText('No customer')).toBeNull();
    expect(screen.queryByText('No serial')).toBeNull();
    expect(screen.getByText('…')).toBeTruthy();

    // Once the fetch resolves with a matching customer, the real verdict renders.
    await act(async () => {
      resolveCtx({
        customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: ['LL01-00000000307'] }],
        serialOwners: [],
      });
    });
    expect(await screen.findByText('Will auto-verify')).toBeTruthy();
  });
});
