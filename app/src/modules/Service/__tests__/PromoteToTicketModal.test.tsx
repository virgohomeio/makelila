import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromoteToTicketModal } from '../PromoteToTicketModal';

const { promoteMock } = vi.hoisted(() => ({
  promoteMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return { ...actual, promoteToTicket: promoteMock };
});

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { email: 'reina@virgohome.io' } }),
}));

beforeEach(() => { promoteMock.mockClear(); });

describe('PromoteToTicketModal', () => {
  it('submits with chosen category + current user email as owner', async () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c1" onClose={onClose} />);

    const submit = screen.getByRole('button', { name: /promote/i });
    fireEvent.click(submit);

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('c1', {
      category: 'support',
      owner_email: 'reina@virgohome.io',
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches category to onboarding when selected', async () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c2" onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'onboarding' } });
    fireEvent.click(screen.getByRole('button', { name: /promote/i }));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('c2', expect.objectContaining({
      category: 'onboarding',
    })));
  });

  it('Cancel does NOT call promoteToTicket', () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c3" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(promoteMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
