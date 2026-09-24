// The team roster, and telling a team member's ticket apart from a customer's.
// Staff had been leaking into public.customers to get a ticket raised for them
// (Huayi Gao, Pedrum Amin, George Yin, Support LILA all sit there under
// @virgohome.io addresses); these helpers are what let a ticket name a
// colleague without one.
// Spec: docs/superpowers/specs/2026-09-24-team-member-support-tickets-design.md
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {},
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn(() => Promise.resolve()) }));

const { matchTeamMembers, holderMatchesMember, isTeamTicket, teamUnits } =
  await import('./team');
type UnitStatus = import('./stock').UnitStatus;

const roster = [
  { email: 'huayi@virgohome.io', display_name: 'Huayi' },
  { email: 'pedrum@virgohome.io', display_name: 'Pedrum' },
  { email: 'junaid@virgohome.io', display_name: 'Junaid' },
  { email: 'george@virgohome.io', display_name: 'George' },
  { email: 'ryanyuan32@gmail.com', display_name: 'Ryan Yuan' },
];

describe('matchTeamMembers', () => {
  it('finds a member by the start of their name', () => {
    expect(matchTeamMembers(roster, 'hua').map(m => m.display_name)).toEqual(['Huayi']);
  });

  it('ignores case', () => {
    expect(matchTeamMembers(roster, 'PEDRUM').map(m => m.display_name)).toEqual(['Pedrum']);
  });

  it('finds a member by email, including one outside the work domain', () => {
    expect(matchTeamMembers(roster, 'ryanyuan32').map(m => m.display_name)).toEqual(['Ryan Yuan']);
  });

  it('returns nothing for an empty query rather than the whole roster', () => {
    // The picker shows results only once you type, same as the customer side.
    expect(matchTeamMembers(roster, '   ')).toEqual([]);
  });

  it('returns nothing when nobody matches', () => {
    expect(matchTeamMembers(roster, 'zzz')).toEqual([]);
  });
});

describe('holderMatchesMember', () => {
  const member = { email: 'junaid@virgohome.io', display_name: 'Junaid' };

  it('matches a bare display name', () => {
    expect(holderMatchesMember({ customer_name: 'Junaid' }, member)).toBe(true);
  });

  it('matches a name carrying an operator suffix', () => {
    // This is the real shape in the units table.
    expect(holderMatchesMember({ customer_name: 'Junaid Siddiqui - Office Machine' }, member))
      .toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(holderMatchesMember({ customer_name: '  junaid siddiqui ' }, member)).toBe(true);
  });

  it('is a prefix match, not a substring one', () => {
    // "George" must not claim a unit held by "Georgia", and a member's name
    // appearing mid-string is a coincidence, not ownership.
    expect(holderMatchesMember(
      { customer_name: 'Georgia Lake' },
      { email: 'george@virgohome.io', display_name: 'George' },
    )).toBe(false);
    expect(holderMatchesMember({ customer_name: 'Sam & Junaid' }, member)).toBe(false);
  });

  it('is false when no holder is recorded', () => {
    expect(holderMatchesMember({ customer_name: null }, member)).toBe(false);
    expect(holderMatchesMember({ customer_name: '   ' }, member)).toBe(false);
  });
});

describe('teamUnits', () => {
  const u = (over: { serial: string; status?: UnitStatus; is_team_test?: boolean }) => ({
    status: 'shipped' as UnitStatus, is_team_test: false, ...over,
  });

  it('takes units flagged is_team_test', () => {
    expect(teamUnits([u({ serial: 'a', is_team_test: true }), u({ serial: 'b' })])
      .map(x => x.serial)).toEqual(['a']);
  });

  it('also takes units whose status is team-test, flag or no flag', () => {
    // LL01-...341 is status 'shipped' AND is_team_test; LL01-...319 is
    // status 'team-test'. Either signal alone means it is ours, not a
    // customer's.
    expect(teamUnits([u({ serial: 'c', status: 'team-test' })]).map(x => x.serial))
      .toEqual(['c']);
  });

  it('leaves customer units alone', () => {
    expect(teamUnits([u({ serial: 'd', status: 'shipped' })])).toEqual([]);
  });
});

describe('isTeamTicket', () => {
  const emails = new Set(roster.map(m => m.email));

  it('is true for a roster address with no customer record behind it', () => {
    expect(isTeamTicket(
      { customer_id: null, customer_email: 'huayi@virgohome.io' }, emails,
    )).toBe(true);
  });

  it('ignores case on the address', () => {
    expect(isTeamTicket(
      { customer_id: null, customer_email: ' Huayi@VirgoHome.io ' }, emails,
    )).toBe(true);
  });

  it('is false when the ticket is tied to a customer record', () => {
    // George Yin exists in public.customers and carries four real tickets.
    // Those are customer tickets, whatever his address says.
    expect(isTeamTicket(
      { customer_id: '4a464861', customer_email: 'george@virgohome.io' }, emails,
    )).toBe(false);
  });

  it('is false for an ordinary customer', () => {
    expect(isTeamTicket(
      { customer_id: null, customer_email: 'gab@example.com' }, emails,
    )).toBe(false);
  });

  it('is false when there is no email to go on', () => {
    expect(isTeamTicket({ customer_id: null, customer_email: null }, emails)).toBe(false);
  });
});
