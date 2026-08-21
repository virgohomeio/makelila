import { describe, it, expect } from 'vitest';
import {
  filterOrders, statusCounts, savedViewCounts, activeFilterCount,
  isBlocked, isOverdue, isReplacement, EMPTY_FILTERS,
} from '../filters';
import type { OrderFilters } from '../filters';
import type { Order } from '../../../lib/orders';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-21T12:00:00Z');
const agoDays = (n: number) => new Date(NOW - n * DAY).toISOString();

function mk(p: Partial<Order> & { id: string; status: Order['status'] }): Order {
  return {
    id: p.id,
    order_ref: p.order_ref ?? `#${p.id}`,
    status: p.status,
    customer_name: p.customer_name ?? 'Test User',
    // `??` would swallow an intentional null — these three fields exist in the
    // fixtures precisely so a test can blank them.
    customer_email: p.customer_email !== undefined ? p.customer_email : 'a@example.com',
    customer_phone: p.customer_phone !== undefined ? p.customer_phone : '+1-555-0100',
    quo_thread_url: null,
    address_line: p.address_line !== undefined ? p.address_line : '1 Way',
    address_line2: null,
    city: p.city ?? 'Portland',
    region_state: 'OR',
    country: p.country ?? 'US',
    address_verdict: p.address_verdict ?? 'house',
    area_type: p.area_type ?? 'suburban',
    area_type_source: 'auto',
    address_verified_at: null, address_match: null,
    address_google_formatted: null, address_google_postal: null, address_customer_postal: null,
    address_claude_verdict: null, address_claude_notes: null, address_claude_postal: null,
    address_confirmed_at: null, address_confirmation_sent_at: null,
    freight_estimate_usd: 89.5, freight_threshold_usd: 200,
    customer_paid_shipping_usd: 89.5, currency: 'USD',
    tracking_num: null, carrier: null, customer_id: null, awaiting_batch_id: null,
    replacement_state: p.replacement_state ?? null,
    held_reason: null, cancelled_at: null, cancelled_reason: null,
    freight_estimate_source: 'shopify', total_usd: 1149,
    subtotal_usd: null, tax_usd: null, discount_total_usd: null,
    discount_codes: null, payment_methods: null, financial_status: null,
    tax_lines: null, shipping_line_title: null,
    attribution_source: null, attribution_medium: null, attribution_campaign: null,
    attribution_referrer: null, attribution_last_source: null,
    attribution_last_medium: null, attribution_last_referrer: null,
    line_items: [],
    sales_confirmed_fit: p.sales_confirmed_fit ?? false,
    dispositioned_by: null, dispositioned_at: null,
    kind: p.kind ?? 'sale',
    linked_ticket_id: null, cogs_usd: null,
    shipping_cost_usd: null, shipping_cost_currency: null,
    shipped_at: null, delivered_at: null,
    created_at: agoDays(1),
    placed_at: p.placed_at ?? agoDays(1),
  };
}

const fresh    = mk({ id: 'a', status: 'pending', order_ref: '#1001', placed_at: agoDays(1) });
const late     = mk({ id: 'b', status: 'pending', order_ref: '#1002', placed_at: agoDays(9) });
const noPhone  = mk({ id: 'c', status: 'pending', order_ref: '#1003', customer_phone: null });
const condo    = mk({ id: 'd', status: 'held',    order_ref: '#1004', address_verdict: 'condo' });
const flagged  = mk({ id: 'e', status: 'flagged', order_ref: '#1005', country: 'CA', area_type: 'rural' });
const done     = mk({ id: 'f', status: 'approved',  order_ref: '#1006', placed_at: agoDays(30) });
const dead     = mk({ id: 'g', status: 'cancelled', order_ref: '#1007' });
const replReady    = mk({ id: 'h', status: 'pending', order_ref: '#R01', kind: 'replacement' });
const replAwaiting = mk({ id: 'i', status: 'pending', order_ref: '#R02', kind: 'replacement', replacement_state: 'awaiting' });

const ALL = [fresh, late, noPhone, condo, flagged, done, dead, replReady, replAwaiting];
const f = (over: Partial<OrderFilters> = {}): OrderFilters => ({ ...EMPTY_FILTERS, ...over });
const refs = (os: Order[]) => os.map(o => o.order_ref);

describe('predicates', () => {
  it('blocks an order missing contact details or address fit', () => {
    expect(isBlocked(noPhone)).toBe(true);
    expect(isBlocked(condo)).toBe(true);
    expect(isBlocked(fresh)).toBe(false);
  });

  it('does not call a confirmed or cancelled order blocked or overdue', () => {
    // Both are past the point where the confirm SLA means anything.
    expect(isBlocked(done)).toBe(false);
    expect(isBlocked(dead)).toBe(false);
    expect(isOverdue(done, NOW)).toBe(false);
    expect(isOverdue(dead, NOW)).toBe(false);
  });

  it('counts an order overdue only past the ceiling', () => {
    expect(isOverdue(fresh, NOW)).toBe(false);
    expect(isOverdue(late, NOW)).toBe(true);
  });

  it('treats a sales-confirmed condo as unblocked', () => {
    expect(isBlocked({ ...condo, sales_confirmed_fit: true })).toBe(false);
  });

  it('recognises live replacement orders only', () => {
    expect(isReplacement(replReady)).toBe(true);
    expect(isReplacement(fresh)).toBe(false);
    expect(isReplacement({ ...replReady, status: 'cancelled' })).toBe(false);
  });
});

describe('counts', () => {
  it('tallies every status', () => {
    expect(statusCounts(ALL)).toEqual({
      pending: 5, held: 1, flagged: 1, approved: 1, cancelled: 1,
    });
  });

  it('tallies the saved views', () => {
    expect(savedViewCounts(ALL, NOW)).toEqual({ blocked: 2, overdue: 1, replacement: 2 });
  });

  it('reports how many filters are narrowing the list', () => {
    expect(activeFilterCount(f())).toBe(0);
    expect(activeFilterCount(f({ status: 'held', query: 'x', country: 'CA' }))).toBe(3);
    // Whitespace is not a filter.
    expect(activeFilterCount(f({ query: '   ' }))).toBe(0);
  });
});

describe('filterOrders', () => {
  it('keeps cancelled orders out of the live queue', () => {
    expect(refs(filterOrders(ALL, f(), NOW))).not.toContain('#1007');
  });

  it('shows only cancelled orders under the cancelled status', () => {
    expect(refs(filterOrders(ALL, f({ status: 'cancelled' }), NOW))).toEqual(['#1007']);
  });

  it('sorts the live queue by order ref', () => {
    expect(refs(filterOrders(ALL, f({ status: 'pending' }), NOW)))
      .toEqual(['#1001', '#1002', '#1003', '#R01', '#R02']);
  });

  // Cancelled arrives newest-first from bucketOrders; re-sorting it by ref
  // would bury the order that was just killed.
  it('leaves the cancelled list in the order it was given', () => {
    const newer = mk({ id: 'z', status: 'cancelled', order_ref: '#9999' });
    const older = mk({ id: 'y', status: 'cancelled', order_ref: '#1000' });
    expect(refs(filterOrders([newer, older], f({ status: 'cancelled' }), NOW)))
      .toEqual(['#9999', '#1000']);
  });

  it('narrows to blocked orders', () => {
    expect(refs(filterOrders(ALL, f({ savedView: 'blocked' }), NOW))).toEqual(['#1003', '#1004']);
  });

  it('narrows to overdue orders', () => {
    expect(refs(filterOrders(ALL, f({ savedView: 'overdue' }), NOW))).toEqual(['#1002']);
  });

  it('splits the replacement queue by stock state', () => {
    expect(refs(filterOrders(ALL, f({ savedView: 'replacement', replacementSub: 'ready' }), NOW)))
      .toEqual(['#R01']);
    expect(refs(filterOrders(ALL, f({ savedView: 'replacement', replacementSub: 'awaiting' }), NOW)))
      .toEqual(['#R02']);
  });

  it('filters by country and by area', () => {
    expect(refs(filterOrders(ALL, f({ country: 'CA' }), NOW))).toEqual(['#1005']);
    expect(refs(filterOrders(ALL, f({ area: 'rural' }), NOW))).toEqual(['#1005']);
  });

  it('searches name, ref, email and city', () => {
    const named = mk({ id: 'n', status: 'pending', order_ref: '#2001', customer_name: 'Marina Voss', city: 'Kelowna' });
    const pool = [...ALL, named];
    expect(refs(filterOrders(pool, f({ query: 'marina' }), NOW))).toEqual(['#2001']);
    expect(refs(filterOrders(pool, f({ query: '2001' }), NOW))).toEqual(['#2001']);
    expect(refs(filterOrders(pool, f({ query: 'kelowna' }), NOW))).toEqual(['#2001']);
  });

  it('combines filters rather than replacing them', () => {
    expect(refs(filterOrders(ALL, f({ status: 'pending', savedView: 'blocked' }), NOW)))
      .toEqual(['#1003']);
  });
});
