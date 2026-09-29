import { describe, it, expect } from 'vitest';
import {
  ADDRESS_ORDER_COLUMNS, buildCustomerAddressIndex, resolveCustomerAddress,
  formatAddressLine, formatAddressBlock, hasResolvedAddress,
  type AddressOrder,
} from './customerAddress';
import type { Customer } from './customers';

// Minimal fixtures — only the columns the resolver reads.
function cust(p: Partial<Customer> & { id: string }): Customer {
  return {
    id: p.id,
    email: p.email ?? null,
    address_line: p.address_line ?? null,
    city: p.city ?? null,
    region: p.region ?? null,
    postal_code: p.postal_code ?? null,
    country: p.country ?? null,
  } as Customer;
}

function ord(p: Partial<AddressOrder> & { order_ref: string }): AddressOrder {
  return {
    order_ref: p.order_ref,
    customer_id: p.customer_id ?? null,
    customer_email: p.customer_email ?? null,
    address_line: p.address_line ?? null,
    address_line2: p.address_line2 ?? null,
    city: p.city ?? null,
    region_state: p.region_state ?? null,
    postal_code: p.postal_code ?? null,
    address_customer_postal: p.address_customer_postal ?? null,
    address_google_postal: p.address_google_postal ?? null,
    country: p.country ?? null,
    placed_at: p.placed_at ?? null,
    created_at: p.created_at ?? '2026-01-01T00:00:00Z',
    address_verified_at: p.address_verified_at ?? null,
  };
}

const resolve = (c: Customer, orders: AddressOrder[]) =>
  resolveCustomerAddress(c, buildCustomerAddressIndex(orders));

describe('resolveCustomerAddress', () => {
  // The bug this module exists for. Order #1272 ships to "901 Concession 14
  // Townsend"; `customers` has no second address line, so HubSpot's seed left
  // the profile reading "901".
  it('takes the second address line from the order, which customers cannot store', () => {
    const brian = cust({
      id: 'c1', email: 'btanchak@live.com',
      address_line: '901', city: 'Simcoe', region: 'ON',
      postal_code: 'N3Y 4K3', country: 'CA',
    });
    const order = ord({
      order_ref: '#1272', customer_id: 'c1', customer_email: 'btanchak@live.com',
      address_line: '901', address_line2: 'Concession 14 Townsend',
      city: 'Simcoe', region_state: 'ON', country: 'CA', postal_code: 'N3Y 4K3',
      address_customer_postal: 'N3Y4K3', address_google_postal: 'N3Y 4K3',
      placed_at: '2026-09-23T17:10:02Z', address_verified_at: '2026-09-29T20:57:31Z',
    });

    const a = resolve(brian, [order]);
    expect(a.source).toBe('order');
    expect(a.line1).toBe('901');
    expect(a.line2).toBe('Concession 14 Townsend');
    expect(a.orderRef).toBe('#1272');
    expect(a.verifiedAt).toBe('2026-09-29T20:57:31Z');
    expect(formatAddressLine(a)).toBe('901 Concession 14 Townsend · Simcoe, ON · N3Y 4K3 · CA');
    expect(formatAddressBlock(a)).toBe('901 Concession 14 Townsend\nSimcoe, ON\nN3Y 4K3  CA');
  });

  it('falls back to the customer record when there is no order', () => {
    const c = cust({
      id: 'c1', email: 'a@b.com', address_line: '5 Elm St',
      city: 'Guelph', region: 'ON', postal_code: 'N1H 1A1', country: 'CA',
    });
    const a = resolve(c, []);
    expect(a.source).toBe('directory');
    expect(a.line1).toBe('5 Elm St');
    expect(a.line2).toBeNull();
    expect(a.orderRef).toBeNull();
  });

  // The INV- series carries a city and a postal code but no street. Letting one
  // win would replace a complete directory address with an incomplete one.
  it('ignores an order with no street line', () => {
    const c = cust({
      id: 'c1', email: 'a@b.com',
      address_line: '265 Galway Crt, Oshawa, Ontario L1J 6K6',
      city: 'Oshawa', region: 'ON', postal_code: 'L1J 6K6', country: 'CA',
    });
    const streetless = ord({
      order_ref: 'INV-1155', customer_id: 'c1',
      city: 'Oshawa', region_state: 'ON', address_customer_postal: 'L1J 6K6', country: 'CA',
      placed_at: '2026-05-01T00:00:00Z',
    });
    const a = resolve(c, [streetless]);
    expect(a.source).toBe('directory');
    expect(a.line1).toBe('265 Galway Crt, Oshawa, Ontario L1J 6K6');
  });

  it('prefers the most recently placed order — people move', () => {
    const c = cust({ id: 'c1', email: 'a@b.com' });
    const older = ord({
      order_ref: '#1000', customer_id: 'c1', address_line: '1 Old Rd',
      city: 'Guelph', placed_at: '2026-01-01T00:00:00Z',
      address_verified_at: '2026-01-02T00:00:00Z',
    });
    const newer = ord({
      order_ref: '#1200', customer_id: 'c1', address_line: '2 New Rd',
      city: 'Ottawa', placed_at: '2026-08-01T00:00:00Z',
    });
    const a = resolve(c, [older, newer]);
    expect(a.line1).toBe('2 New Rd');
    expect(a.orderRef).toBe('#1200');
    expect(a.verifiedAt).toBeNull();
  });

  it('breaks a same-day tie with the verified order', () => {
    const c = cust({ id: 'c1', email: 'a@b.com' });
    const unverified = ord({
      order_ref: '#1201', customer_id: 'c1', address_line: '9 Typo St',
      placed_at: '2026-08-01T00:00:00Z',
    });
    const verified = ord({
      order_ref: '#1202', customer_id: 'c1', address_line: '9 Real St',
      placed_at: '2026-08-01T00:00:00Z', address_verified_at: '2026-08-02T00:00:00Z',
    });
    const a = resolve(c, [unverified, verified]);
    expect(a.line1).toBe('9 Real St');
    expect(a.orderRef).toBe('#1202');
  });

  it('falls back to placed_at-less orders by created_at', () => {
    const c = cust({ id: 'c1', email: 'a@b.com' });
    const a = resolve(c, [
      ord({ order_ref: 'R-1', customer_id: 'c1', address_line: '1 A St', created_at: '2026-02-01T00:00:00Z' }),
      ord({ order_ref: 'R-2', customer_id: 'c1', address_line: '2 B St', created_at: '2026-03-01T00:00:00Z' }),
    ]);
    expect(a.orderRef).toBe('R-2');
  });

  // Same rule as lib/heldUnits: the FK is authoritative and the soft key is a
  // fallback, never a peer — otherwise a shared or mistyped email pulls one
  // customer's order onto another's profile.
  it('matches by email only when the order has no customer_id', () => {
    const c = cust({ id: 'c1', email: 'a@b.com' });
    const elsewhere = ord({
      order_ref: '#1300', customer_id: 'c2', customer_email: 'a@b.com',
      address_line: '3 Wrong Ave', placed_at: '2026-08-01T00:00:00Z',
    });
    expect(resolve(c, [elsewhere]).source).toBe('directory');

    const unlinked = ord({
      order_ref: '#1301', customer_email: 'A@B.com',
      address_line: '4 Right Ave', placed_at: '2026-08-01T00:00:00Z',
    });
    const a = resolve(c, [unlinked]);
    expect(a.source).toBe('order');
    expect(a.line1).toBe('4 Right Ave');
  });

  // Most orders have never been through Verify, so the verify columns are null
  // and the order's own postal_code is the only one there is. Reading only the
  // verify pair blanked the postal code on 25 of the rows this resolver touches.
  it('shows the order postal code, not Google\'s ZIP+4 restatement of it', () => {
    const c = cust({ id: 'c1' });
    const a = resolve(c, [ord({
      order_ref: '#1', customer_id: 'c1', address_line: '1 A St',
      postal_code: '98382', address_google_postal: '98382-4095',
      placed_at: '2026-08-01T00:00:00Z',
    })]);
    expect(a.postal_code).toBe('98382');
  });

  it('falls back to the typed postal code when that is all there is', () => {
    const c = cust({ id: 'c1' });
    const a = resolve(c, [ord({
      order_ref: '#1', customer_id: 'c1', address_line: '1 A St',
      address_customer_postal: 'N3Y4K3', placed_at: '2026-08-01T00:00:00Z',
    })]);
    expect(a.postal_code).toBe('N3Y4K3');
  });
});

describe('hasResolvedAddress', () => {
  it('is false only when nothing locates the customer', () => {
    const blank = cust({ id: 'c1' });
    expect(hasResolvedAddress(resolve(blank, []))).toBe(false);
    // A city alone still locates someone — matches the directory's existing
    // "No address" chip, which counts city / region / postal.
    expect(hasResolvedAddress(resolve(cust({ id: 'c1', city: 'Simcoe' }), []))).toBe(true);
    expect(hasResolvedAddress(resolve(blank, [ord({
      order_ref: '#1', customer_id: 'c1', address_line: '1 A St',
      placed_at: '2026-08-01T00:00:00Z',
    })]))).toBe(true);
  });
});

describe('formatting', () => {
  it('skips the parts that are blank', () => {
    const a = resolve(cust({ id: 'c1', city: 'Simcoe', country: 'CA' }), []);
    expect(formatAddressLine(a)).toBe('Simcoe · CA');
    expect(formatAddressBlock(a)).toBe('Simcoe\nCA');
  });

  it('collapses a newline inside an imported street line', () => {
    const a = resolve(cust({ id: 'c1' }), [ord({
      order_ref: 'R-1', customer_id: 'c1',
      address_line: '727 W Twin River Way\nApt 2138',
      city: 'Salt Lake City', region_state: 'UT', postal_code: '84123',
    })]);
    expect(formatAddressLine(a)).toBe('727 W Twin River Way Apt 2138 · Salt Lake City, UT · 84123');
  });

  it('is empty when there is no address at all', () => {
    const a = resolve(cust({ id: 'c1' }), []);
    expect(formatAddressLine(a)).toBe('');
    expect(formatAddressBlock(a)).toBe('');
  });
});

describe('ADDRESS_ORDER_COLUMNS', () => {
  // The select list and the type are two statements of the same fact. A column
  // added to one and not the other reads back as null at runtime with nothing
  // failing — which is how the postal code went missing the first time.
  it('selects exactly the fields the resolver reads', () => {
    const selected = ADDRESS_ORDER_COLUMNS.split(',').map(s => s.trim()).filter(Boolean);
    const declared = Object.keys(ord({ order_ref: '#1' }));
    expect([...selected].sort()).toEqual([...declared].sort());
  });
});
