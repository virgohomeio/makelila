import { describe, it, expect } from 'vitest';
import {
  normaliseOrderRef,
  refundFlagForOrder,
  indexRefundFlags,
  refundFlagLabel,
  refundFlagTitle,
  type RefundMark,
  type FlaggableOrder,
} from './refundedOrders';

const order = (o: Partial<FlaggableOrder> = {}): FlaggableOrder => ({
  id: 'order-1',
  order_ref: '#1231',
  customer_email: 'lisa@example.com',
  customer_name: 'Lisa Clarke',
  ...o,
});

const mark = (m: Partial<RefundMark> = {}): RefundMark => ({
  id: 'refund-1',
  status: 'refunded',
  order_id: null,
  customer_email: 'lisa@example.com',
  customer_name: 'Lisa Clarke',
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
    ['INV-1134', 'inv-1134'],
    ['inv-1134', 'inv-1134'],
    ['INV-R1205', 'inv-r1205'],
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
    expect(normaliseOrderRef("I don't know, please ask Edward")).toBe('');
  });
});

describe('refundFlagForOrder', () => {
  it('flags at order level on the UUID link', () => {
    const flag = refundFlagForOrder(order(), [mark({ order_id: 'order-1', customer_email: null })]);
    expect(flag).toMatchObject({ level: 'order', settled: true, refundId: 'refund-1' });
  });

  it('flags at order level on a human ref, however it was typed', () => {
    // Shopify writes '#1134' and the customer types '1134' into the return
    // form. Same order. 'INV-1134' is NOT — see the INV- series tests below.
    const flag = refundFlagForOrder(
      order({ order_ref: '#1134', customer_email: null }),
      [mark({ order_ref: '1134', customer_email: null })],
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

// ---------------------------------------------------------------------------
// Two false positives found in production on 2026-09-10. Both blocked a live
// order at the confirm step — assertNotRefunded throws on an order-level flag —
// for money that had gone back to somebody else entirely.
// ---------------------------------------------------------------------------

describe('a ref match that names a different customer', () => {
  // Raymond Keetch's #1216 (paid, pending) wore REFUNDED because Cheryl
  // Lemieux's return typed '1216' into original_order_ref six weeks before
  // #1216 existed. Cheryl has no order in the table at all, so her ref names
  // nothing we hold — but it normalised equal, and sameOrder never looked at
  // who either row belonged to.
  const keetch = order({
    id: 'o-1216', order_ref: '#1216',
    customer_email: 'raykeetch@gmail.com', customer_name: 'Raymond Keetch',
  });
  const lemieux = mark({
    id: 'r-lemieux', order_ref: '1216',
    customer_email: 'cheryllemieuxkandr@gmail.com', customer_name: 'Cheryl Lemieux',
  });

  it('does not claim the order itself was refunded', () => {
    expect(refundFlagForOrder(keetch, [lemieux])?.level).not.toBe('order');
  });

  it('warns at ref level instead, so the operator can still see it', () => {
    expect(refundFlagForOrder(keetch, [lemieux])).toMatchObject({
      level: 'ref', settled: true, refundId: 'r-lemieux',
    });
  });

  it('still flags at order level when only the email differs but the name agrees', () => {
    // Brent Neave really was refunded for #1093. His order carries
    // b.neave@shaw.ca and his refund card brent@baker-neave.com — one person,
    // two addresses. Dropping this to a warning would put a machine he has
    // already been paid back for onto the truck.
    const flag = refundFlagForOrder(
      order({ order_ref: '#1093', customer_email: 'b.neave@shaw.ca', customer_name: 'Brent Neave' }),
      [mark({ order_ref: '#1093', customer_email: 'brent@baker-neave.com', customer_name: 'Brent Neave' })],
    );
    expect(flag?.level).toBe('order');
  });

  it('reads through a joint account and a shouted surname', () => {
    // Real pairs: 'Chad Lockhart' vs 'Chad & Sarah Lockhart Anne' (R-0043),
    // and 'Joseph Thavundayil' vs 'Joseph THAVUNDAYIL' (#1174).
    expect(refundFlagForOrder(
      order({ order_ref: 'R-0043', customer_email: 'sarahmeecham87@icloud.com', customer_name: 'Chad & Sarah Lockhart Anne' }),
      [mark({ order_ref: 'R-0043', customer_email: 'chadlockhart@icloud.com', customer_name: 'Chad Lockhart' })],
    )?.level).toBe('order');
    expect(refundFlagForOrder(
      order({ order_ref: '#1174', customer_email: 'thajos@douglas.mcgill.ca', customer_name: 'Joseph THAVUNDAYIL' }),
      [mark({ order_ref: '#1174', customer_email: 'thajos@douglas.mcgill.ca', customer_name: 'Mr. Joseph Thavundayil' })],
    )?.level).toBe('order');
  });

  it('needs more than a shared first name to block', () => {
    expect(refundFlagForOrder(
      order({ order_ref: '#1300', customer_email: 'a@example.com', customer_name: 'Michael Haywood' }),
      [mark({ order_ref: '#1300', customer_email: 'b@example.com', customer_name: 'Michael Madigan' })],
    )?.level).toBe('ref');
  });

  it('keeps the UUID link authoritative whoever the names say', () => {
    // A resolved FK is a decision someone made, not a string coincidence.
    expect(refundFlagForOrder(keetch, [mark({ ...lemieux, order_id: 'o-1216' })])?.level).toBe('order');
  });

  it('prefers a real order-level match over a bare ref collision', () => {
    const flag = refundFlagForOrder(keetch, [
      lemieux,
      mark({ id: 'his', order_id: 'o-1216', customer_name: 'Raymond Keetch' }),
    ]);
    expect(flag).toMatchObject({ level: 'order', refundId: 'his' });
  });
});

describe('the INV- series is not the # series', () => {
  // All 14 INV- orders in production collide with a different #-series order
  // belonging to a different customer. Stripping 'INV-' merged every one of
  // them. Olivia & Jason Amaro's INV-1174 wore REFUNDED off Joseph
  // Thavundayil's refund for #1174.
  it('does not match INV-1174 to a refund for #1174', () => {
    expect(refundFlagForOrder(
      order({ order_ref: 'INV-1174', customer_email: 'liv_1976@hotmail.com', customer_name: 'Olivia & Jason Amaro' }),
      [mark({ order_ref: '#1174', customer_email: 'thajos@douglas.mcgill.ca', customer_name: 'Joseph Thavundayil' })],
    )).toBeNull();
  });

  it('still matches an INV- order to a refund that names it', () => {
    expect(refundFlagForOrder(
      order({ order_ref: 'INV-1169', customer_email: 's@example.com', customer_name: 'Scott Destephanis' }),
      [mark({ order_ref: 'inv-1169', customer_email: 's@example.com', customer_name: 'Scott Destephanis' })],
    )?.level).toBe('order');
  });
});

describe('refundFlagLabel / refundFlagTitle', () => {
  it('names who filed the refund on a ref collision, and does not say refunded', () => {
    const flag = refundFlagForOrder(
      order({ order_ref: '#1216', customer_email: 'raykeetch@gmail.com', customer_name: 'Raymond Keetch' }),
      [mark({ order_ref: '1216', customer_email: 'c@example.com', customer_name: 'Cheryl Lemieux' })],
    )!;
    expect(refundFlagLabel(flag)).toBe('CHECK REFUND');
    expect(refundFlagTitle(flag)).toContain('Cheryl Lemieux');
    expect(refundFlagTitle(flag)).not.toMatch(/^This order was refunded/);
  });
});
