// The customer directory search box. A record is a household: the purchaser,
// the primary user of the machine, and anyone else in the house we talk to.
// An operator is usually handed the name of whoever USES the machine, so a
// search that only reads customers.full_name hides the record they need.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

const { matchCustomerSearch } = await import('./customers');
type Cust = Parameters<typeof matchCustomerSearch>[0];
type User = Parameters<typeof matchCustomerSearch>[1][number];

const cust = (over: Partial<Cust> = {}): Cust => ({
  full_name: 'Chad Wu',
  email: 'chad@example.com',
  phone: '416-555-0100',
  city: 'Toronto',
  region: 'ON',
  primary_user_name: null,
  primary_user_email: null,
  primary_user_phone: null,
  primary_user_relationship: null,
  ...over,
});

const user = (over: Partial<User> = {}): User => ({
  full_name: 'Mia Wu',
  email: null,
  phone: null,
  relationship: null,
  ...over,
});

describe('matchCustomerSearch', () => {
  it('matches everyone on an empty query', () => {
    expect(matchCustomerSearch(cust(), [], '')).toEqual({ matched: true, via: null });
    expect(matchCustomerSearch(cust(), [], '   ')).toEqual({ matched: true, via: null });
  });

  it('matches the purchaser without annotating the row', () => {
    for (const q of ['chad', 'CHAD@example.com', '555-0100', 'toronto', 'on']) {
      expect(matchCustomerSearch(cust(), [], q)).toEqual({ matched: true, via: null });
    }
  });

  it('does not match an unrelated query', () => {
    expect(matchCustomerSearch(cust(), [user()], 'zzz')).toEqual({ matched: false, via: null });
  });

  it('finds a record by its primary user name', () => {
    const c = cust({ primary_user_name: 'Sarah Lockhart', primary_user_relationship: 'Spouse / partner' });
    expect(matchCustomerSearch(c, [], 'sarah')).toEqual({
      matched: true, via: 'Sarah Lockhart · Spouse / partner',
    });
  });

  it('finds a record by a primary user email or phone', () => {
    const c = cust({ primary_user_name: 'Sarah Lockhart', primary_user_email: 'sarah@example.com', primary_user_phone: '519-555-0142' });
    expect(matchCustomerSearch(c, [], 'sarah@example').via).toBe('Sarah Lockhart');
    expect(matchCustomerSearch(c, [], '519-555').via).toBe('Sarah Lockhart');
  });

  it('finds a record by another household user', () => {
    const users = [user({ full_name: 'Mia Wu', relationship: 'Child' })];
    expect(matchCustomerSearch(cust(), users, 'mia')).toEqual({ matched: true, via: 'Mia Wu · Child' });
  });

  it('reports the household user that actually matched', () => {
    const users = [user({ full_name: 'Mia Wu' }), user({ full_name: 'Ravi Patel', relationship: 'Roommate' })];
    expect(matchCustomerSearch(cust(), users, 'ravi').via).toBe('Ravi Patel · Roommate');
  });

  it('prefers the purchaser over a household user with a shared surname', () => {
    // "Wu" hits both. The purchaser owns the record, so the row reads plainly
    // rather than claiming it surfaced via the child.
    const users = [user({ full_name: 'Mia Wu', relationship: 'Child' })];
    expect(matchCustomerSearch(cust(), users, 'wu')).toEqual({ matched: true, via: null });
  });

  it('falls back to a contact detail when a household user has no name', () => {
    const users = [user({ full_name: '', email: 'mia@example.com' })];
    expect(matchCustomerSearch(cust(), users, 'mia@').via).toBe('mia@example.com');
  });
});
