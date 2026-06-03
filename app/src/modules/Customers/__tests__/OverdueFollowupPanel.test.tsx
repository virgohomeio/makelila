import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OverdueFollowupPanel } from '../OverdueFollowupPanel';

const { generateMock, sendMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return {
    ...actual,
    generateFollowupDrafts: generateMock,
    sendFollowupSms: sendMock,
  };
});

beforeEach(() => {
  generateMock.mockReset();
  sendMock.mockReset();
});

describe('OverdueFollowupPanel', () => {
  it('renders nothing when overdueCount is 0', () => {
    const { container } = render(<OverdueFollowupPanel overdueCount={0} overdueCustomerIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count + Generate button when overdueCount > 0', () => {
    render(<OverdueFollowupPanel overdueCount={42} overdueCustomerIds={[]} />);
    expect(screen.getByText(/42 customers overdue/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument();
  });

  it('renders drafts after Generate click', async () => {
    generateMock.mockResolvedValue({
      drafts: [
        {
          customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
          days_overdue: 5, fu_kind: 'fu1',
          draft_message: 'hey alice, hope your lila is going well!',
          skip_reason: null, context_summary: 'shipped 5/12, no Quo activity',
        },
        {
          customer_id: 'c2', customer_name: 'Bob', customer_phone: null,
          days_overdue: 10, fu_kind: 'fu1',
          draft_message: null, skip_reason: 'No phone on file', context_summary: 'No phone on file',
        },
      ],
    });
    render(<OverdueFollowupPanel overdueCount={2} overdueCustomerIds={['c1','c2']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => expect(screen.getByText(/hey alice/i)).toBeInTheDocument());
    expect(screen.getByText(/No phone on file/i)).toBeInTheDocument();
  });

  it('Approve calls sendFollowupSms and collapses the row', async () => {
    generateMock.mockResolvedValue({
      drafts: [{
        customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
        days_overdue: 5, fu_kind: 'fu1',
        draft_message: 'hey alice!', skip_reason: null, context_summary: '',
      }],
    });
    sendMock.mockResolvedValue({ ok: true });
    render(<OverdueFollowupPanel overdueCount={1} overdueCustomerIds={['c1']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => screen.getByText(/hey alice/i));

    fireEvent.click(screen.getByRole('button', { name: /approve & send/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({
      customer_id: 'c1',
      message: 'hey alice!',
    }));
    await waitFor(() => expect(screen.getByText(/✓ sent to alice/i)).toBeInTheDocument());
  });

  it('Skip collapses the row without sending', async () => {
    generateMock.mockResolvedValue({
      drafts: [{
        customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
        days_overdue: 5, fu_kind: 'fu1',
        draft_message: 'hey alice!', skip_reason: null, context_summary: '',
      }],
    });
    render(<OverdueFollowupPanel overdueCount={1} overdueCustomerIds={['c1']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));
    await waitFor(() => screen.getByText(/hey alice/i));

    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
    expect(sendMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/— skipped/i)).toBeInTheDocument());
  });
});
