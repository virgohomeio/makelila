import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { confirmTestMock, flagReworkMock } = vi.hoisted(() => ({
  confirmTestMock: vi.fn(() => Promise.resolve()),
  flagReworkMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/fulfillment', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fulfillment')>('../../../lib/fulfillment');
  return {
    ...actual,
    confirmTestReport: confirmTestMock,
    flagRework: flagReworkMock,
  };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    profile: { id: 'u1', display_name: 'Aaron', role: 'member' },
    user: { id: 'u1', email: 'aaron@virgohome.io' },
    session: null, loading: false, signInWithGoogle: vi.fn(), signOut: vi.fn(),
  }),
}));

import { StepTest } from '../queue/StepTest';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

const row: FulfillmentQueueRow = {
  id: 'q-test', order_id: 'o-test', step: 2, assigned_serial: 'LL01-00000000050',
  test_report_url: null, test_confirmed_at: null, test_confirmed_by: null,
  carrier: null, tracking_num: null, label_pdf_path: null,
  label_confirmed_at: null, label_confirmed_by: null,
  dock_printed: false, dock_affixed: false, dock_docked: false, dock_notified: false,
  dock_confirmed_at: null, dock_confirmed_by: null,
  starter_tracking_num: null, email_sent_at: null, email_sent_by: null,
  fulfilled_at: null, fulfilled_by: null, due_date: null, created_at: '2026-04-19T00:00:00Z',
};

describe('StepTest', () => {
  beforeEach(() => {
    confirmTestMock.mockClear();
    flagReworkMock.mockClear();
  });

  it('Test passed calls confirmTestReport with the URL', async () => {
    render(<StepTest row={row} />);
    fireEvent.change(screen.getByPlaceholderText(/drive\.google/i), {
      target: { value: 'https://drive.example/test.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /test passed/i }));
    await waitFor(() => {
      expect(confirmTestMock).toHaveBeenCalledWith('q-test', 'https://drive.example/test.pdf');
    });
  });

  it('Flag rework requires an issue; calls flagRework with serial + issue + reporter', async () => {
    render(<StepTest row={row} />);
    fireEvent.click(screen.getByRole('button', { name: /flag to aaron/i }));
    const flagBtn = screen.getByRole('button', { name: /flag rework/i });
    expect(flagBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/what's wrong/i), {
      target: { value: 'visible crack on top lid' },
    });
    expect(flagBtn).toBeEnabled();
    fireEvent.click(flagBtn);
    await waitFor(() => {
      expect(flagReworkMock).toHaveBeenCalledWith('q-test', 'LL01-00000000050', 'visible crack on top lid', 'Aaron');
    });
  });
});
