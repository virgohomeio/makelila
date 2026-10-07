// The refund card's contact block: every card has to show an email, a phone
// and an address for the customer, or say plainly that one isn't on file.
// Case records (refunds / returns / cancellations) never carry an address and
// often carry no phone, so the customer directory backfills — these tests pin
// down that resolution order and the "don't guess" rules around it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

const {
  formatCustomerAddress, resolveCustomerContact, buildContactIndex, lookupContactRow,
} = await import('./customers');

const dir = (over: Record<string, unknown> = {}) => ({
  email: 'gab@example.com',
  phone: '+1 416 555 0142',
  address_line: '12 Elm St',
  city: 'Toronto',
  region: 'ON',
  postal_code: 'M4B 1B3',
  country: 'Canada',
  ...over,
});

describe('formatCustomerAddress', () => {
  it('joins the parts it has, in mailing order', () => {
    expect(formatCustomerAddress(dir())).toBe('12 Elm St, Toronto, ON, M4B 1B3, Canada');
  });

  it('skips blank parts instead of leaving empty commas', () => {
    expect(formatCustomerAddress(dir({ region: null, country: '  ' })))
      .toBe('12 Elm St, Toronto, M4B 1B3');
  });

  it('is null when nothing about the address is on file', () => {
    expect(formatCustomerAddress(dir({
      address_line: null, city: null, region: null, postal_code: null, country: null,
    }))).toBeNull();
    expect(formatCustomerAddress(null)).toBeNull();
  });
});

describe('resolveCustomerContact', () => {
  it('prefers the case record over the directory for email and phone', () => {
    expect(resolveCustomerContact({
      caseEmail: 'corrected@example.com',
      casePhone: '+1 647 555 0199',
      directory: dir(),
    })).toEqual({
      email: 'corrected@example.com',
      phone: '+1 647 555 0199',
      address: '12 Elm St, Toronto, ON, M4B 1B3, Canada',
    });
  });

  it('backfills from the directory when the case has nothing — the manual-card gap', () => {
    expect(resolveCustomerContact({ caseEmail: null, casePhone: null, directory: dir() }))
      .toEqual({
        email: 'gab@example.com',
        phone: '+1 416 555 0142',
        address: '12 Elm St, Toronto, ON, M4B 1B3, Canada',
      });
  });

  it('treats a blank case value as missing, not as an override', () => {
    expect(resolveCustomerContact({ caseEmail: '   ', casePhone: '', directory: dir() }).phone)
      .toBe('+1 416 555 0142');
  });

  it('reports null per field when neither side has it', () => {
    expect(resolveCustomerContact({ caseEmail: 'x@y.com', casePhone: null, directory: null }))
      .toEqual({ email: 'x@y.com', phone: null, address: null });
  });
});

describe('buildContactIndex / lookupContactRow', () => {
  const rows = [
    { id: 'c1', email: 'Gab@Example.com', full_name: 'Gabriella Hottya' },
    { id: 'c2', email: 'other@example.com', full_name: 'Chad Smith' },
  ];

  it('matches on email case-insensitively', () => {
    const idx = buildContactIndex(rows);
    expect(lookupContactRow(idx, { email: '  GAB@example.com ' })?.id).toBe('c1');
  });

  it('falls back to the name when the card has no email', () => {
    const idx = buildContactIndex(rows);
    expect(lookupContactRow(idx, { email: null, name: 'gabriella hottya' })?.id).toBe('c1');
  });

  it('prefers the email match over a conflicting name', () => {
    const idx = buildContactIndex(rows);
    expect(lookupContactRow(idx, { email: 'other@example.com', name: 'Gabriella Hottya' })?.id)
      .toBe('c2');
  });

  it('refuses to guess when two customers share a name', () => {
    const idx = buildContactIndex([
      ...rows,
      { id: 'c3', email: 'chad2@example.com', full_name: 'Chad Smith' },
    ]);
    expect(lookupContactRow(idx, { name: 'Chad Smith' })).toBeNull();
    // ...but each is still reachable by their own email.
    expect(lookupContactRow(idx, { email: 'chad2@example.com' })?.id).toBe('c3');
  });

  it('returns null rather than a stranger when nothing matches', () => {
    const idx = buildContactIndex(rows);
    expect(lookupContactRow(idx, { email: 'nobody@example.com', name: 'Nobody' })).toBeNull();
  });

  it('ignores rows with no email when indexing by email', () => {
    const idx = buildContactIndex([{ id: 'c9', email: null, full_name: 'No Email' }]);
    expect(lookupContactRow(idx, { email: null, name: 'No Email' })?.id).toBe('c9');
    expect(idx.byEmail.size).toBe(0);
  });
});
