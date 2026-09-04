// Mock fixtures pass `as any` to satisfy the polymorphic supabase client
// surface — this is the right escape valve for test mocks; the runtime
// behavior is what the tests assert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('./supabase', () => ({ supabase: { from: fromMock } }));

import { resolveRefundOrderId } from './refundedOrders';

type OrderRow = {
  id: string; order_ref: string; customer_email: string | null;
  kind?: 'sale' | 'replacement';
};

/** The `orders` table as a plain list; `.or()` filtering is Postgrest's job, so
 *  the double returns everything and lets the function do the narrowing. */
function ordersTable(rows: OrderRow[]) {
  fromMock.mockImplementation(() => ({
    select: () => ({
      or: () => Promise.resolve({ data: rows.map(r => ({ kind: 'sale', ...r })), error: null }),
    }),
  } as any));
}

describe('resolveRefundOrderId', () => {
  beforeEach(() => { fromMock.mockReset(); });

  it('pins a return to the order its human ref names', async () => {
    ordersTable([
      { id: 'o-1098', order_ref: '#1098', customer_email: 'lisa@example.com' },
      { id: 'o-1231', order_ref: '#1231', customer_email: 'lisa@example.com' },
    ]);
    expect(await resolveRefundOrderId('lisa@example.com', '1098')).toBe('o-1098');
  });

  it('matches across the ref spellings the three importers use', async () => {
    ordersTable([{ id: 'o-1', order_ref: 'INV-1169', customer_email: 's@example.com' }]);
    expect(await resolveRefundOrderId('s@example.com', '#1169')).toBe('o-1');
  });

  it('narrows a colliding ref by the customer', async () => {
    ordersTable([
      { id: 'o-a', order_ref: '#1134', customer_email: 'a@example.com' },
      { id: 'o-b', order_ref: 'INV-1134', customer_email: 'b@example.com' },
    ]);
    expect(await resolveRefundOrderId('b@example.com', '1134')).toBe('o-b');
  });

  it('refuses to guess when a ref is ambiguous and there is no email to narrow by', async () => {
    ordersTable([
      { id: 'o-a', order_ref: '#1134', customer_email: 'a@example.com' },
      { id: 'o-b', order_ref: 'INV-1134', customer_email: 'b@example.com' },
    ]);
    expect(await resolveRefundOrderId(null, '1134')).toBeNull();
  });

  it('falls back to the email when the customer has exactly one order', async () => {
    ordersTable([{ id: 'o-1', order_ref: '#1300', customer_email: 'solo@example.com' }]);
    expect(await resolveRefundOrderId('solo@example.com', null)).toBe('o-1');
  });

  it('will not pin a refund to the customer\'s warranty replacement', async () => {
    // Lily Xu: the sale she was refunded for is not in the orders table, and her
    // only remaining row is a replacement she is still owed. Linking them would
    // block that machine from shipping.
    ordersTable([{ id: 'r-0048', order_ref: 'R-0048', customer_email: 'lily@example.com', kind: 'replacement' }]);
    expect(await resolveRefundOrderId('lily@example.com', null)).toBeNull();
  });

  it('refuses to guess between several orders of the same customer', async () => {
    ordersTable([
      { id: 'o-1', order_ref: '#1098', customer_email: 'lisa@example.com' },
      { id: 'o-2', order_ref: '#1231', customer_email: 'lisa@example.com' },
    ]);
    expect(await resolveRefundOrderId('lisa@example.com', null)).toBeNull();
  });

  it('returns null for the free text people type into the return form', async () => {
    ordersTable([{ id: 'o-1', order_ref: '#1300', customer_email: 'a@example.com' }]);
    expect(await resolveRefundOrderId(null, "I don't know, please ask Edward")).toBeNull();
    expect(await resolveRefundOrderId(null, null)).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('never throws — a failed lookup must not block compiling a refund case', async () => {
    fromMock.mockImplementation(() => { throw new Error('network'); });
    await expect(resolveRefundOrderId('a@example.com', '#1098')).resolves.toBeNull();
  });
});
