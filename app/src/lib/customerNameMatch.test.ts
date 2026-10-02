import { describe, it, expect } from 'vitest';
import {
  normalizeCustomerName,
  matchUnitToCustomer,
  isAutoLinkable,
  type NameMatchable,
} from './customerNameMatch';

// Every string below is a real value from the live DB (txeftbbzeflequvrmjjr) as
// of 2026-09-02, so these tests pin the behaviour against the actual mess rather
// than an invented one.
const CUSTOMERS: NameMatchable[] = [
  { id: 'kevin',      full_name: 'Kevin Cheng' },
  { id: 'phil',       full_name: 'Mr. Phil Parkinson' },
  { id: 'yuanbo',     full_name: 'Ms. Yuanbo Luo' },
  { id: 'william',    full_name: 'Yun Feng Zhang (William)' },
  { id: 'rongbin',    full_name: 'Rongbin Sun (2 units, only delivering 1 white) (Kevin will be the receiver)' },
  { id: 'rongbing-a', full_name: 'Rongbing Sun' },
  { id: 'rongbing-b', full_name: 'Rongbing Sun' },
  { id: 'oskamp',     full_name: 'Mary & Marilynne Oskamp' },
  { id: 'louis',      full_name: 'Louis DiPalma' },
  { id: 'duckworth',  full_name: 'David Duckworth' },
];

describe('normalizeCustomerName', () => {
  it('strips parenthetical asides, including several in one name', () => {
    expect(normalizeCustomerName('Louis DiPalma (test)')).toBe('louis dipalma');
    expect(normalizeCustomerName('Yun Feng Zhang (William)')).toBe('yun feng zhang');
    expect(
      normalizeCustomerName('Rongbin Sun (2 units, only delivering 1 white) (Kevin will be the receiver)'),
    ).toBe('rongbin sun');
  });

  it('strips leading honorifics', () => {
    expect(normalizeCustomerName('Mr. Phil Parkinson')).toBe('phil parkinson');
    expect(normalizeCustomerName('Ms. Yuanbo Luo')).toBe('yuanbo luo');
  });

  it('strips a trailing sequence number', () => {
    expect(normalizeCustomerName('Camp Jubilee 2')).toBe('camp jubilee');
    expect(normalizeCustomerName('Camp Jubilee 3')).toBe('camp jubilee');
  });

  it('does not strip digits that are part of the name proper', () => {
    expect(normalizeCustomerName('Studio 54 Holdings')).toBe('studio 54 holdings');
  });

  it('handles null and empty input', () => {
    expect(normalizeCustomerName(null)).toBe('');
    expect(normalizeCustomerName('   ')).toBe('');
  });
});

describe('matchUnitToCustomer', () => {
  it('matches an exact name outright', () => {
    const m = matchUnitToCustomer('Kevin Cheng', CUSTOMERS);
    expect(m).toMatchObject({ customerId: 'kevin', confidence: 'exact' });
  });

  it('matches through an honorific the unit does not carry', () => {
    const m = matchUnitToCustomer('Phil Parkinson', CUSTOMERS);
    expect(m).toMatchObject({ customerId: 'phil', confidence: 'normalized' });
  });

  it('matches through an operator annotation on the customer record', () => {
    // The annotation itself says "2 units", which is why both LL01-…006 and
    // LL01-…024 belong to this record.
    const m = matchUnitToCustomer('Rongbin Sun', CUSTOMERS);
    expect(m).toMatchObject({ customerId: 'rongbin', confidence: 'normalized' });
  });

  it('matches through a (test) suffix on the unit', () => {
    const m = matchUnitToCustomer('Louis DiPalma (test)', CUSTOMERS);
    expect(m).toMatchObject({ customerId: 'louis', confidence: 'normalized' });
  });

  // The important negative cases. Getting either of these wrong silently
  // reassigns somebody's machine.
  it('refuses to guess between duplicate customer records', () => {
    const m = matchUnitToCustomer('Rongbing Sun', CUSTOMERS);
    expect(m.confidence).toBe('ambiguous');
    expect(m.customerId).toBeNull();
    expect(m.candidates).toHaveLength(2);
    expect(isAutoLinkable(m)).toBe(false);
  });

  it('does not collapse a household name into one of its members', () => {
    // LL01-…005 is correctly FK-linked to "Mary & Marilynne Oskamp" while Stock
    // calls it "Mary Oskamp". The matcher must not treat these as equal — the
    // existing link is right and must survive reconciliation untouched.
    const m = matchUnitToCustomer('Mary Oskamp', CUSTOMERS);
    expect(m.confidence).toBe('none');
    expect(m.customerId).toBeNull();
  });

  it('returns none when nothing resembles the name', () => {
    // "Camp Jubilee 2" normalises to "camp jubilee", which matches no record;
    // the institutional grouping onto David Duckworth is a judgement call the
    // migration makes explicitly, not something the matcher may infer.
    expect(matchUnitToCustomer('Camp Jubilee 2', CUSTOMERS).confidence).toBe('none');
    expect(matchUnitToCustomer('Junaid Siddiqui - Office Machine', CUSTOMERS).confidence).toBe('none');
  });

  it('returns none for blank input rather than matching a blank record', () => {
    expect(matchUnitToCustomer(null, CUSTOMERS).confidence).toBe('none');
    expect(matchUnitToCustomer('  ', CUSTOMERS).confidence).toBe('none');
  });
});

describe('isAutoLinkable', () => {
  it('permits exact and normalized, refuses ambiguous and none', () => {
    expect(isAutoLinkable(matchUnitToCustomer('Kevin Cheng', CUSTOMERS))).toBe(true);
    expect(isAutoLinkable(matchUnitToCustomer('Phil Parkinson', CUSTOMERS))).toBe(true);
    expect(isAutoLinkable(matchUnitToCustomer('Rongbing Sun', CUSTOMERS))).toBe(false);
    expect(isAutoLinkable(matchUnitToCustomer('Nobody At All', CUSTOMERS))).toBe(false);
  });
});
