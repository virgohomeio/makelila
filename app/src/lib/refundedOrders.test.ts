import { describe, it, expect } from 'vitest';
import {
  normaliseOrderRef,
  refundFlagForOrder,
  indexRefundFlags,
  type RefundMark,
  type FlaggableOrder,
} from './refundedOrders';

const order = (o: Partial<FlaggableOrder> = {}): FlaggableOrder => ({
  id: 'order-1',
  order_ref: '#1231',
  customer_email: 'lisa@example.com',
  ...o,
});

const mark = (m: Partial<RefundMark> = {}): RefundMark => ({
  id: 'refund-1',
  status: 'refunded',
  order_id: null,
  customer_email: 'lisa@example.com',
  order_ref: null,
  refunded_at: '2026-08-24T00:00:00Z',
  refund_amount_usd: 833.38,
  ...m,
});

describe('normaliseOrderRef', () => {
  it.each([
    ['#1134', '1134'],
    ['1134', '1134'],
    [' #1134 ', '1134'],
    ['INV-1134', '1134'],
    ['inv-1134', '1134'],
    ['R-0043', 'r-0043'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseOrderRef(input)).toBe(expected);
  });

  it('is empty for refs that name no order', () => {
    // returns.original_order_ref is a free-text field on a public form; people
    // write sentences in it. An empty result must never match anything.
    expect(normaliseOrderRef(null)).toBe('');
    expect(normaliseOrderRef('')).toBe('');
    expect(normaliseOrderRef('   ')).toBe('');
    expect(normaliseOrderRef('#')).toBe('');
    expect(normaliseOrderRef('INV-')).toBe('');
  });
});

describe('refundFlagForOrder', () => {
  it('flags at order level on the UUID link', () => {
    const flag = refundFlagForOrder(order(), [mark({ order_id: 'order-1', customer_email: null })]);
    expect(flag).toMatchObject({ level: 'order', settled: true, refundId: 'refund-1' });
  });

  it('flags at order level on a human ref, however it was typed', () => {
    const flag = refundFlagForOrder(
      order({ order_ref: '#1134', customer_email: null }),
      [mark({ order_ref: 'INV-1134', customer_email: null })],
    );
    expect(flag).toMatchObject({ level: 'order', settled: true });
  });

  it('flags at customer level when a different order of theirs was refunded', () => {
    // Lisa Clarke: #1098 refunded, #1231 still open. Shipping #1231 may be
    // perfectly correct — the operator decides, so this warns, never blocks.
    const flag = refundFlagForOrder(order({ order_ref: '#1231' }), [mark({ order_ref: '#1098' })]);
    expect(flag).toMatchObject({ level: 'customer', settled: true });
  });

  it('matches the customer regardless of email case', () => {
    const flag = refundFlagForOrder(
      order({ customer_email: 'Jefy@outlook.in' }),
      [mark({ customer_email: 'jefy@outlook.in' })],
    );
    expect(flag?.level).toBe('customer');
  });

  it('prefers the order-level match when a customer has both', () => {
    const flag = refundFlagForOrder(order({ order_ref: '#1098' }), [
      mark({ id: 'other', order_ref: '#1231' }),
      mark({ id: 'same', order_ref: '#1098' }),
    ]);
    expect(flag).toMatchObject({ level: 'order', refundId: 'same' });
  });

  it('reports an in-flight refund as unsettled', () => {
    const flag = refundFlagForOrder(order(), [
      mark({ status: 'finance_review', refunded_at: null, order_id: 'order-1' }),
    ]);
    expect(flag).toMatchObject({ level: 'order', settled: false });
  });

  it('prefers a settled refund over an in-flight one at the same level', () => {
    const flag = refundFlagForOrder(order(), [
      mark({ id: 'live', status: 'manager_review', refunded_at: null, order_id: 'order-1' }),
      mark({ id: 'paid', status: 'refunded', order_id: 'order-1' }),
    ]);
    expect(flag).toMatchObject({ settled: true, refundId: 'paid' });
  });

  it('ignores denied and closed refunds', () => {
    // A denied card is a decision NOT to refund — it must not stop a shipment.
    expect(refundFlagForOrder(order(), [mark({ status: 'denied', refunded_at: null })])).toBeNull();
    expect(refundFlagForOrder(order(), [mark({ status: 'closed', refunded_at: null })])).toBeNull();
  });

  it.each(['submitted', 'manager_review', 'finance_review', 'refund_queue', 'refunded'])(
    'treats %s as bearing on shipping', (status) => {
      // These five must stay in step with the status list fetchRefundMarks asks
      // the server for — a status in one and not the other means the badge and
      // the guard disagree.
      expect(refundFlagForOrder(order(), [mark({ status, order_id: 'order-1' })])).not.toBeNull();
    });

  it('is null when nothing matches', () => {
    expect(refundFlagForOrder(order(), [mark({ customer_email: 'someone@else.com' })])).toBeNull();
    expect(refundFlagForOrder(order(), [])).toBeNull();
  });

  it('never matches an order on a blank email or a blank ref', () => {
    // 18 of 18 live refunds have order_id NULL and most have no usable ref.
    // A blank-matches-blank bug here would flag the entire order book.
    expect(refundFlagForOrder(
      order({ customer_email: null, order_ref: '' }),
      [mark({ customer_email: null, order_ref: null })],
    )).toBeNull();
    expect(refundFlagForOrder(
      order({ customer_email: '', order_ref: '#1231' }),
      [mark({ customer_email: '', order_ref: "I don't know, please ask Edward" })],
    )).toBeNull();
  });
});

describe('indexRefundFlags', () => {
  it('maps every flagged order id to its flag and leaves clean orders out', () => {
    const orders = [
      order({ id: 'a', order_ref: '#1098', customer_email: 'lisa@example.com' }),
      order({ id: 'b', order_ref: '#1231', customer_email: 'lisa@example.com' }),
      order({ id: 'c', order_ref: '#1300', customer_email: 'clean@example.com' }),
    ];
    const index = indexRefundFlags(orders, [mark({ order_ref: '#1098' })]);
    expect(index.get('a')?.level).toBe('order');
    expect(index.get('b')?.level).toBe('customer');
    expect(index.has('c')).toBe(false);
  });
});
