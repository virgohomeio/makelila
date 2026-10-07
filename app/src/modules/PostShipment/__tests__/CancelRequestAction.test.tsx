// The one control that pulls a request off the Refunds board, used by both
// card types (cancellation requests and refund cards).
//
// The reason is the whole point of the feature: a card that vanishes with no
// explanation is indistinguishable from one somebody processed. So the reason
// is required before the button will commit, and a database refusal has to
// leave the operator looking at their own words, not an empty card.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CancelRequestAction } from '../CancelRequestAction';

const onCancel = vi.fn(async (_reason: string) => {});
const onError = vi.fn();

const openForm = () => fireEvent.click(screen.getByRole('button', { name: /cancel request/i }));
const reasonBox = () => screen.getByPlaceholderText(/why/i);
const confirmBtn = () => screen.getByRole('button', { name: /^confirm/i });

beforeEach(() => {
  onCancel.mockReset();
  onCancel.mockResolvedValue(undefined);
  onError.mockReset();
});

const renderAction = (props: Partial<React.ComponentProps<typeof CancelRequestAction>> = {}) =>
  render(<CancelRequestAction onCancel={onCancel} onError={onError} {...props} />);

describe('CancelRequestAction', () => {
  it('asks for a reason before it will do anything', () => {
    renderAction();
    expect(screen.queryByPlaceholderText(/why/i)).toBeNull();
    openForm();
    expect(reasonBox()).toBeTruthy();
    expect(confirmBtn()).toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('stays shut while the reason is only whitespace', () => {
    renderAction();
    openForm();
    fireEvent.change(reasonBox(), { target: { value: '   ' } });
    expect(confirmBtn()).toBeDisabled();
  });

  it('hands over the trimmed reason', async () => {
    renderAction();
    openForm();
    fireEvent.change(reasonBox(), { target: { value: '  Pedrum test order  ' } });
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith('Pedrum test order'));
  });

  it('keeps the typed reason on screen when the write is refused', async () => {
    onCancel.mockRejectedValue(new Error('row-level security'));
    renderAction();
    openForm();
    fireEvent.change(reasonBox(), { target: { value: 'duplicate' } });
    fireEvent.click(confirmBtn());

    await waitFor(() => expect(onError).toHaveBeenCalledWith('row-level security'));
    // Still open, still holding what they wrote — so they can retry or copy it
    // rather than type it a second time.
    expect((reasonBox() as HTMLTextAreaElement).value).toBe('duplicate');
  });

  it('backs out without cancelling anything', () => {
    renderAction();
    openForm();
    fireEvent.change(reasonBox(), { target: { value: 'never mind' } });
    fireEvent.click(screen.getByRole('button', { name: /keep request/i }));
    expect(screen.queryByPlaceholderText(/why/i)).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('can be labelled for the card it sits on', () => {
    renderAction({ label: '✕ Cancel refund request' });
    expect(screen.getByRole('button', { name: /cancel refund request/i })).toBeTruthy();
  });
});
