// Manually adding a customer from the Directory. Every other row in
// public.customers arrives from a sync, so this is the one path where an
// operator's typing goes straight into the table — these tests pin the rules
// that keep a hand-typed row indistinguishable from a synced one.
// Spec: docs/superpowers/specs/2026-09-24-manual-add-customer-design.md
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

const { normalizeNewCustomer, EMPTY_NEW_CUSTOMER } = await import('./customers');

const input = (over: Partial<typeof EMPTY_NEW_CUSTOMER> = {}) => ({
  ...EMPTY_NEW_CUSTOMER,
  first_name: 'Gabriella',
  last_name: 'Hottya',
  ...over,
});

describe('normalizeNewCustomer', () => {
  it('keeps the name fields it was given, trimmed', () => {
    const row = normalizeNewCustomer(input({ first_name: '  Gabriella ', last_name: ' Hottya  ' }));
    expect(row.first_name).toBe('Gabriella');
    expect(row.last_name).toBe('Hottya');
  });

  it('never writes full_name — it is a generated column', () => {
    expect(normalizeNewCustomer(input())).not.toHaveProperty('full_name');
  });

  it('accepts a whole compound name in first_name with no last name', () => {
    // Many synced rows are shaped this way ("James & Jill Washington"), and
    // splitting one across first/last would double the surname on display.
    const row = normalizeNewCustomer(input({ first_name: 'James & Jill Washington', last_name: '' }));
    expect(row.first_name).toBe('James & Jill Washington');
    expect(row.last_name).toBeNull();
  });

  it('accepts a last name alone', () => {
    const row = normalizeNewCustomer(input({ first_name: '', last_name: 'Washington' }));
    expect(row.first_name).toBeNull();
    expect(row.last_name).toBe('Washington');
  });

  it('refuses a row with no name at all — it would be unfindable', () => {
    expect(() => normalizeNewCustomer(input({ first_name: '  ', last_name: '' })))
      .toThrow(/name/i);
  });

  it('lowercases and trims the email', () => {
    expect(normalizeNewCustomer(input({ email: '  Gab@Example.COM ' })).email)
      .toBe('gab@example.com');
  });

  it('rejects an email that is obviously a typo', () => {
    expect(() => normalizeNewCustomer(input({ email: 'gab@example' })))
      .toThrow(/email/i);
  });

  it('allows no email at all — plenty of records start without one', () => {
    expect(normalizeNewCustomer(input({ email: '   ' })).email).toBeNull();
  });

  it('stores every blank optional field as NULL, not an empty string', () => {
    // The "no email" / "no address" directory filters test for NULL-ish
    // values; an empty string would hide the gap instead of reporting it.
    const row = normalizeNewCustomer(input());
    expect(row.phone).toBeNull();
    expect(row.address_line).toBeNull();
    expect(row.city).toBeNull();
    expect(row.region).toBeNull();
    expect(row.postal_code).toBeNull();
    expect(row.country).toBeNull();
    expect(row.notes).toBeNull();
  });

  it('trims the address fields it was given', () => {
    const row = normalizeNewCustomer(input({
      phone: ' 519-555-0142 ', address_line: ' 12 Elm St ', city: ' Toronto ',
      region: ' ON ', postal_code: ' M4B 1B3 ', country: ' CA ', notes: ' Trade show lead ',
    }));
    expect(row).toMatchObject({
      phone: '519-555-0142', address_line: '12 Elm St', city: 'Toronto',
      region: 'ON', postal_code: 'M4B 1B3', country: 'CA', notes: 'Trade show lead',
    });
  });

  it('leaves last_synced_at unset — this row was never synced', () => {
    expect(normalizeNewCustomer(input())).not.toHaveProperty('last_synced_at');
  });
});
