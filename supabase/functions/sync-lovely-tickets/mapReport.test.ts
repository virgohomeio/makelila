import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  normalizeSerial, isLookupSafeSerial, resolveCustomer, reportToTicket,
  type DamageReport, type CustomerLookups,
} from './mapReport.ts';

const report = (over: Partial<DamageReport> = {}): DamageReport => ({
  id: 'r1', user_id: 'u1', serial_number: 'LL01-00000000372',
  notes: 'Lid cracked', created_at: '2026-09-30T12:00:00Z', ...over,
});

const lookups = (over: Partial<CustomerLookups> = {}): CustomerLookups => ({
  customerIdBySerial: new Map(),
  linkByUserId: new Map(),
  knownSerials: new Set(),
  customerById: new Map(),
  ...over,
});

Deno.test('normalizeSerial: trims and uppercases, empty becomes null', () => {
  assertEquals(normalizeSerial(' ll01-00000000372 '), 'LL01-00000000372');
  assertEquals(normalizeSerial('   '), null);
  assertEquals(normalizeSerial(null), null);
});

Deno.test('resolveCustomer: serial match wins over the app link', () => {
  const out = resolveCustomer(report(), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c-serial']]),
    linkByUserId: new Map([['u1', { customer_id: 'c-link', email: 'link@x.com' }]]),
    customerById: new Map([
      ['c-serial', { full_name: 'Sam Serial', email: 'sam@x.com' }],
      ['c-link', { full_name: 'Lee Link', email: 'lee@x.com' }],
    ]),
  }));
  assertEquals(out, { customer_id: 'c-serial', customer_name: 'Sam Serial', customer_email: 'sam@x.com' });
});

Deno.test('resolveCustomer: untidy serial still matches the unit', () => {
  const out = resolveCustomer(report({ serial_number: ' ll01-00000000372 ' }), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c1']]),
    customerById: new Map([['c1', { full_name: 'Sam Serial', email: 'sam@x.com' }]]),
  }));
  assertEquals(out.customer_id, 'c1');
});

Deno.test('resolveCustomer: falls back to the app link when the serial is unknown', () => {
  const out = resolveCustomer(report(), lookups({
    linkByUserId: new Map([['u1', { customer_id: 'c-link', email: 'link@x.com' }]]),
    customerById: new Map([['c-link', { full_name: 'Lee Link', email: 'lee@x.com' }]]),
  }));
  assertEquals(out, { customer_id: 'c-link', customer_name: 'Lee Link', customer_email: 'lee@x.com' });
});

Deno.test('resolveCustomer: unresolved link still yields its email', () => {
  const out = resolveCustomer(report(), lookups({
    linkByUserId: new Map([['u1', { customer_id: null, email: 'link@x.com' }]]),
  }));
  assertEquals(out, { customer_id: null, customer_name: null, customer_email: 'link@x.com' });
});

Deno.test('resolveCustomer: nothing known gives an empty customer', () => {
  const out = resolveCustomer(report({ serial_number: null, user_id: null }), lookups());
  assertEquals(out, { customer_id: null, customer_name: null, customer_email: null });
});

Deno.test('resolveCustomer: blank customer name becomes null', () => {
  const out = resolveCustomer(report(), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c1']]),
    customerById: new Map([['c1', { full_name: '  ', email: 'sam@x.com' }]]),
  }));
  assertEquals(out.customer_name, null);
});

Deno.test('reportToTicket: full report', () => {
  const row = reportToTicket(report({ serial_number: ' ll01-00000000372 ' }), {
    customer_id: 'c1', customer_name: 'Sam Serial', customer_email: 'sam@x.com',
  }, true);
  assertEquals(row, {
    source: 'lovely_app', kind: 'ticket', category: 'support',
    status: 'waiting_on_us', priority: 'normal', issue_area: 'shipping',
    subject: 'Damage report: LL01-00000000372',
    description: 'Lid cracked',
    unit_serial: 'LL01-00000000372',
    customer_id: 'c1', customer_name: 'Sam Serial', customer_email: 'sam@x.com',
    lovely_report_id: 'r1',
    created_at: '2026-09-30T12:00:00Z',
  });
});

Deno.test('reportToTicket: no serial, no notes, no date', () => {
  const row = reportToTicket(
    report({ serial_number: null, notes: '   ', created_at: null }),
    { customer_id: null, customer_name: null, customer_email: null },
    false,
  );
  assertEquals(row.subject, 'Damage report from Lovely app');
  assertEquals(row.description, 'No notes provided.');
  assertEquals(row.unit_serial, null);
  // No created_at key at all, so the column default (now()) applies.
  assertEquals('created_at' in row, false);
});

// service_tickets.unit_serial is a foreign key to units(serial): a serial
// makelila has no unit for must not be written there, or the insert fails.
Deno.test('reportToTicket: serial with no matching unit stays out of unit_serial', () => {
  const row = reportToTicket(
    report({ serial_number: 'LL01-00000009999' }),
    { customer_id: null, customer_name: null, customer_email: null },
    false,
  );
  assertEquals(row.unit_serial, null);
  assertEquals(row.subject, 'Damage report: LL01-00000009999');
  assertEquals(
    row.description,
    'Lid cracked\n\nSerial entered in the Lovely app: LL01-00000009999. It matched no unit in makelila, so any unit shown on this ticket was inferred from the customer.',
  );
});

// A customer-typed serial goes into a PostgREST `in (...)` filter. One that
// could break the filter syntax must be left out, or it fails every sync run.
Deno.test('isLookupSafeSerial: accepts real serials, rejects filter-breaking input', () => {
  assertEquals(isLookupSafeSerial('LL01-00000000372'), true);
  assertEquals(isLookupSafeSerial('LL01"),(X'), false);
  assertEquals(isLookupSafeSerial('A\\B'), false);
  assertEquals(isLookupSafeSerial('A B'), false);
  assertEquals(isLookupSafeSerial('X'.repeat(41)), false);
});
