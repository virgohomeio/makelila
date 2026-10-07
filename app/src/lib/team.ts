import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import type { Unit } from './stock';

// The team roster, and the units the team holds.
//
// Why this exists: a support ticket could only be raised for a customer, so
// raising one for a colleague running a LILA Pro meant giving them a customer
// record. That already happened four times — Huayi Gao, Pedrum Amin, George Yin
// and Support LILA all sit in public.customers under @virgohome.io addresses —
// and staff in that table land in customer counts, the purchaser CSV, the
// Klaviyo push and every profitability rollup that divides by customers.
//
// public.team_invite_list (email -> display_name) is the roster the app
// already keeps; TicketDetailPanel carries a hand-copied version of it in
// OPS_OWNERS with a comment saying it should read the table directly. This is
// the first consumer that does.
// Spec: docs/superpowers/specs/2026-09-24-team-member-support-tickets-design.md

export type TeamMember = {
  email: string;
  display_name: string;
};

/** A ticket, reduced to what says whether it is about a colleague. */
type TicketSubjectLike = {
  customer_id: string | null;
  customer_email: string | null;
};

/** A unit, reduced to what says whether the team holds it and who has it. */
type TeamUnitLike = Pick<Unit, 'status' | 'is_team_test'> & { customer_name?: string | null };

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/** Roster search for the ticket dialog's subject picker. Returns nothing for a
 *  blank query — the picker shows results only once you type, same as the
 *  customer search beside it. */
export function matchTeamMembers(roster: TeamMember[], query: string): TeamMember[] {
  const q = norm(query);
  if (!q) return [];
  return roster.filter(m => norm(m.display_name).includes(q) || norm(m.email).includes(q));
}

/** Units the team holds rather than a customer. Either signal is enough:
 *  LL01-…341 is `shipped` and flagged, LL01-…319 is `team-test` and not. */
export function teamUnits<T extends TeamUnitLike>(units: T[]): T[] {
  return units.filter(u => u.is_team_test || u.status === 'team-test');
}

/** Does this unit's free-text holder name this member?
 *
 *  Holders are recorded in `units.customer_name` as an operator typed them —
 *  "Pedrum", "Junaid Siddiqui - Office Machine", "Hassan - Marketing Intern" —
 *  so the test is a PREFIX match on the display name. Substring would let
 *  "George" claim a unit held by "Georgia Lake", and a name appearing in the
 *  middle of a string ("Sam & Junaid") is a coincidence, not ownership. */
export function holderMatchesMember(
  unit: { customer_name?: string | null },
  member: TeamMember,
): boolean {
  const holder = norm(unit.customer_name);
  const name = norm(member.display_name);
  if (!holder || !name) return false;
  return holder === name || holder.startsWith(`${name} `);
}

/** True when a ticket is about a colleague rather than a customer.
 *
 *  There is no `is_team` column — the signal is a roster address with no
 *  customer record behind it. The `customer_id` half matters: George Yin is on
 *  the roster AND is a customer carrying four real tickets, and those are
 *  customer tickets whatever his address says. */
export function isTeamTicket(ticket: TicketSubjectLike, teamEmails: Set<string>): boolean {
  if (ticket.customer_id) return false;
  const email = norm(ticket.customer_email);
  return email !== '' && teamEmails.has(email);
}

/** The roster, plus its addresses as a Set for isTeamTicket(). Read-only for
 *  authenticated users; the table is tiny and changes a couple of times a year,
 *  so there is no realtime subscription. */
export function useTeamRoster(): {
  members: TeamMember[];
  emails: Set<string>;
  loading: boolean;
} {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('team_invite_list')
        .select('email, display_name')
        .order('display_name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setMembers(data as TeamMember[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return {
    members,
    emails: new Set(members.map(m => m.email.trim().toLowerCase())),
    loading,
  };
}

/** Record who holds a team unit, in the same free-text field Pedrum's and
 *  Junaid's already use. Twelve of the fifteen team units have no holder on
 *  file, which is why a team member's serial has to be picked by hand the
 *  first time and is remembered afterwards. */
export async function setTeamUnitHolder(serial: string, displayName: string): Promise<void> {
  const holder = displayName.trim();
  if (!holder) throw new Error('A team unit needs a holder name.');
  const { error } = await supabase
    .from('units')
    .update({ customer_name: holder })
    .eq('serial', serial);
  if (error) throw error;
  await logAction('stock_team_holder', serial, holder,
    { entityType: 'unit', unitSerial: serial });
}
