import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewOrderForm from '../NewOrderForm';
import { createManualOrder } from '../../../lib/orders';

vi.mock('../../../lib/orders', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/orders')>('../../../lib/orders');
  return {
    ...actual,
    createManualOrder: vi.fn(() =>
      Promise.resolve({ id: 'o-new', order_ref: 'M-0001', status: 'pending' as const }),
    ),
  };
});

const fill = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The two required fields, so a test can get to the button it cares about. */
function fillMinimum() {
  fireEvent.change(screen.getByPlaceholderText('Dana Whitfield'), { target: { value: 'Dana Whitfield' } });
  const city = screen.getByText('City *').parentElement!.querySelector('input')!;
  fireEvent.change(city, { target: { value: 'Toronto' } });
}

const createBtn = () => screen.getByRole('button', { name: 'Create order' });

beforeEach(() => {
  vi.mocked(createManualOrder).mockClear();
});

describe('NewOrderForm', () => {
  it('will not submit without a customer and a city', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(createBtn()).toBeDisabled();

    fillMinimum();
    expect(createBtn()).toBeEnabled();
  });

  it('has no freight field', () => {
    // The pre-ship gate reads a manual freight estimate as a carrier quote
    // having been run. A field here would let an operator pass that gate by
    // typing a number — see the note at the top of the component.
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    // Matched narrowly: the phone hint legitimately mentions the freight
    // carrier wanting a number, and a bare /freight/ catches that.
    expect(screen.queryByText(/freight estimate/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/freight (estimate|cost|amount|rate|charge)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/shipping (cost|amount|charge)/i)).not.toBeInTheDocument();
  });

  it('has no order-reference field', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByLabelText(/order (ref|number)/i)).not.toBeInTheDocument();
  });

  it('warns that an order with no phone number lands in Flagged', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText(/arrives in/i)).toBeInTheDocument();
    expect(screen.getByText(/Creates it at/)).toHaveTextContent('Flagged');

    fireEvent.change(screen.getByPlaceholderText('+1 416 555 0123'), { target: { value: '+14165550123' } });
    expect(screen.getByText(/Creates it at/)).toHaveTextContent('Pending');
  });

  it('totals the lines as they are typed', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    fill(/Line 1 quantity/, '2');
    fill(/Line 1 unit price/, '2499');
    expect(screen.getByText(/2 units/)).toBeInTheDocument();
    expect(screen.getByText('$4998.00 CAD')).toBeInTheDocument();
  });

  it('adds and removes lines, keeping at least one', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('Remove line 1')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '+ Add a line' }));
    expect(screen.getByLabelText('Line 2 product')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove line 2'));
    expect(screen.queryByLabelText('Line 2 product')).not.toBeInTheDocument();
  });

  it('switches currency with the destination country', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    fill(/Line 1 unit price/, '100');
    expect(screen.getByText('$100.00 CAD')).toBeInTheDocument();

    const country = screen.getByText('Country').parentElement!.querySelector('select')!;
    fireEvent.change(country, { target: { value: 'US' } });
    expect(screen.getByText('$100.00 USD')).toBeInTheDocument();
  });

  it('blocks a date before the Sales cutoff, which no tab would show', () => {
    render(<NewOrderForm onClose={vi.fn()} onCreated={vi.fn()} />);
    fillMinimum();
    const date = screen.getByText('Date placed').parentElement!.querySelector('input')!;

    fireEvent.change(date, { target: { value: '2026-01-15' } });
    expect(screen.getByText(/appear in no tab here/)).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();

    fireEvent.change(date, { target: { value: '2026-09-30' } });
    expect(createBtn()).toBeEnabled();
  });

  it('submits what was typed and hands the new order back', async () => {
    const onCreated = vi.fn();
    render(<NewOrderForm onClose={vi.fn()} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.change(screen.getByPlaceholderText('+1 416 555 0123'), { target: { value: '+14165550123' } });
    fireEvent.change(screen.getByPlaceholderText('88 Palmerston Ave'), { target: { value: '88 Palmerston Ave' } });
    fill(/Line 1 unit price/, '2499');
    fireEvent.click(createBtn());

    await waitFor(() => expect(createManualOrder).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createManualOrder).mock.calls[0][0]).toMatchObject({
      customer_name: 'Dana Whitfield',
      customer_phone: '+14165550123',
      address: { city: 'Toronto', address_line: '88 Palmerston Ave', country: 'CA' },
      currency: 'CAD',
      financial_status: 'paid',
      line_items: [{ name: 'LILA Pro', qty: 1, price_usd: 2499 }],
    });
    expect(onCreated).toHaveBeenCalledWith({ id: 'o-new', order_ref: 'M-0001', status: 'pending' });
  });

  it('shows a failure and keeps the form open', async () => {
    vi.mocked(createManualOrder).mockRejectedValueOnce(new Error('Could not create the order: boom'));
    const onCreated = vi.fn();
    render(<NewOrderForm onClose={vi.fn()} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(createBtn());

    await waitFor(() => expect(screen.getByText(/Could not create the order: boom/)).toBeInTheDocument());
    expect(onCreated).not.toHaveBeenCalled();
    expect(createBtn()).toBeEnabled();
  });
});
