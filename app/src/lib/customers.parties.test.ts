// FR-6 applied to service tickets: a ticket names the person who actually uses
// the machine, while still saying who paid for it. The rules here MUST match
// resolveRefundParties() — a household that reads as "Mia" on a refund card and
// "Sarah" on a support ticket is how one machine becomes two people.
//
// A ticket carries only a denormalised customer_name snapshot, so every name
// here is resolved at read time from the directory. Nothing is invented: with
// no directory row we fall back to the snapshot rather than guess.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

const { resolveCustomerParties } = await import('./customers');

type Row = Parameters<typeof resolveCustomerParties>[0]['customer'];

const row = (over: Record<string, unknown> = {}): NonNullable<Row> => ({
  id: 'c-chad',
  full_name: 'Chad Wu',
  phone: '+1 416 555 0100',
  email: 'chad@example.com',
  purchaser_id: null,
  primary_user_name: null,
  primary_user_phone: null,
  primary_user_email: null,
  primary_user_relationship: null,
  ...over,
}) as NonNullable<Row>;

const index = (...rows: NonNullable<Row>[]) => {
  const m = new Map<string, NonNullable<Row>>();
  for (const r of rows) m.set(r.id, r);
  return m;
};

describe('resolveCustomerParties — no directory row', () => {
  it('falls back to the ticket snapshot and reports no split', () => {
    const p = resolveCustomerParties({
      customer: null,
      fallbackName: 'Chad Wu',
      fallbackPhone: '+1 416 555 0100',
      fallbackEmail: 'chad@example.com',
    });
    expect(p.displayName).toBe('Chad Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(false);
    expect(p.phone).toBe('+1 416 555 0100');
    expect(p.email).toBe('chad@example.com');
  });

  it('never invents a name when the ticket has no snapshot either', () => {
    const p = resolveCustomerParties({ customer: null, fallbackName: null });
    expect(p.displayName).toBe('');
    expect(p.split).toBe(false);
  });
});

describe('resolveCustomerParties — customer is their own purchaser', () => {
  it('shows one name when no primary user is named', () => {
    const p = resolveCustomerParties({ customer: row() });
    expect(p.displayName).toBe('Chad Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(false);
    expect(p.phone).toBe('+1 416 555 0100');
  });

  it('promotes a named primary user to the headline', () => {
    const p = resolveCustomerParties({
      customer: row({
        primary_user_name: 'Sarah Wu',
        primary_user_phone: '+1 416 555 0199',
        primary_user_email: 'sarah@example.com',
        primary_user_relationship: 'Spouse / partner',
      }),
    });
    expect(p.displayName).toBe('Sarah Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(true);
    expect(p.relationship).toBe('Spouse / partner');
    // Outbound messages address the primary user, so their own contact wins.
    expect(p.phone).toBe('+1 416 555 0199');
    expect(p.email).toBe('sarah@example.com');
  });

  it('treats a whitespace-only primary user name as absent', () => {
    const p = resolveCustomerParties({ customer: row({ primary_user_name: '   ' }) });
    expect(p.displayName).toBe('Chad Wu');
    expect(p.split).toBe(false);
  });

  it('does not split when the primary user IS the purchaser under a different casing', () => {
    const p = resolveCustomerParties({ customer: row({ primary_user_name: '  chad wu ' }) });
    expect(p.split).toBe(false);
    expect(p.displayName).toBe('Chad Wu');
  });

  it('falls back to the purchaser phone when the primary user has none on file', () => {
    const p = resolveCustomerParties({
      customer: row({ primary_user_name: 'Sarah Wu' }),
    });
    expect(p.displayName).toBe('Sarah Wu');
    expect(p.phone).toBe('+1 416 555 0100');
    expect(p.email).toBe('chad@example.com');
  });
});

describe('resolveCustomerParties — customer links to a purchaser (gift / household)', () => {
  const chad = row({ id: 'c-chad', full_name: 'Chad Wu' });
  const sarah = row({
    id: 'c-sarah',
    full_name: 'Sarah Wu',
    phone: '+1 416 555 0199',
    email: 'sarah@example.com',
    purchaser_id: 'c-chad',
  });

  it('headlines the linked user and names the purchaser behind them', () => {
    const p = resolveCustomerParties({ customer: sarah, byId: index(chad, sarah) });
    expect(p.displayName).toBe('Sarah Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(true);
    expect(p.phone).toBe('+1 416 555 0199');
  });

  it('lets a primary user named on the purchaser outrank the linked user', () => {
    // Chad bought it, Sarah's row links to him, but Chad's record says the
    // machine's primary user is their daughter Mia. Mia wins — same precedence
    // as resolveRefundParties, so both modules name the same person.
    const chadNamesMia = row({
      id: 'c-chad',
      full_name: 'Chad Wu',
      primary_user_name: 'Mia Wu',
      primary_user_phone: '+1 416 555 0177',
      primary_user_relationship: 'Child',
    });
    const p = resolveCustomerParties({
      customer: sarah,
      byId: index(chadNamesMia, sarah),
    });
    expect(p.displayName).toBe('Mia Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(true);
    expect(p.relationship).toBe('Child');
    expect(p.phone).toBe('+1 416 555 0177');
  });

  it('degrades to the row itself when the purchaser link dangles', () => {
    const orphan = row({ id: 'c-sarah', full_name: 'Sarah Wu', purchaser_id: 'c-missing' });
    const p = resolveCustomerParties({ customer: orphan, byId: index(orphan) });
    expect(p.displayName).toBe('Sarah Wu');
    expect(p.purchaserName).toBe('Sarah Wu');
    expect(p.split).toBe(false);
  });
});

describe('buildPartyResolver', () => {
  const chad = row({ id: 'c-chad', full_name: 'Chad Wu', primary_user_name: 'Sarah Wu' });
  const solo = row({ id: 'c-solo', full_name: 'Dana Reid', phone: null, email: null });

  it('resolves a ticket by customer_id through the directory', async () => {
    const { buildPartyResolver } = await import('./customers');
    const partiesFor = buildPartyResolver([chad, solo]);
    const p = partiesFor({ customerId: 'c-chad', fallbackName: 'Chad Wu' });
    expect(p.displayName).toBe('Sarah Wu');
    expect(p.purchaserName).toBe('Chad Wu');
    expect(p.split).toBe(true);
  });

  it('falls back to the ticket snapshot for an unlinked ticket', async () => {
    const { buildPartyResolver } = await import('./customers');
    const partiesFor = buildPartyResolver([chad]);
    const p = partiesFor({ customerId: null, fallbackName: 'Walk-in Wendy' });
    expect(p.displayName).toBe('Walk-in Wendy');
    expect(p.split).toBe(false);
  });

  it('falls back to the snapshot when the customer_id is not in the directory', async () => {
    const { buildPartyResolver } = await import('./customers');
    const partiesFor = buildPartyResolver([chad]);
    const p = partiesFor({ customerId: 'c-ghost', fallbackName: 'Ghost Gary' });
    expect(p.displayName).toBe('Ghost Gary');
    expect(p.split).toBe(false);
  });
});

describe('resolveCustomerParties — agreement with the refund card', () => {
  it('resolves the same primary user that resolveRefundParties would', async () => {
    const { resolveRefundParties } = await import('./customers');
    const chad = row({ id: 'c-chad', full_name: 'Chad Wu', primary_user_name: 'Sarah Wu' });

    const refund = resolveRefundParties({
      filerEmail: 'chad@example.com',
      filerName: 'Chad Wu',
      byEmail: new Map([['chad@example.com', {
        id: 'c-chad', full_name: 'Chad Wu', purchaser_id: null, primary_user_name: 'Sarah Wu',
      }]]),
      byId: new Map([['c-chad', { full_name: 'Chad Wu', primary_user_name: 'Sarah Wu' }]]),
    });
    const ticket = resolveCustomerParties({ customer: chad });

    expect(ticket.displayName).toBe(refund.primaryUser);
    expect(ticket.purchaserName).toBe(refund.purchaser);
  });
});
