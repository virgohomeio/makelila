// Resolving a unit's free-text `units.customer_name` to a canonical
// `customers.id`.
//
// Why this exists: `units.customer_id` was populated once by the June 2026
// fulfilment backfill and never maintained, while `units.customer_name` is
// hand-edited in the Stock tab and stays current. Reconciling the two means
// matching an operator-typed string against `customers.full_name` — which is a
// GENERATED column, `trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))`,
// and in practice holds the entire name in `first_name` with `last_name` null.
// So there are no reliable components to match on; the whole string has to be
// normalised on both sides.
//
// Deliberately pure and Supabase-free so the rules can be tested against the
// real messy values without a database.

/** Honorifics that appear on `customers.full_name` but not on the unit
 *  ("Mr. Phil Parkinson" vs "Phil Parkinson"). */
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof)\.?\s+/i;

/**
 * Casefold a name to its comparable core.
 *
 * Strips, in order: parenthetical asides, leading honorifics, a trailing
 * sequence number, and redundant whitespace. Everything here is a pattern
 * observed in live data — see the test file for the source values.
 */
export function normalizeCustomerName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase();
  // "Louis DiPalma (test)", "Yun Feng Zhang (William)", and the customer record
  // literally named "Rongbin Sun (2 units, only delivering 1 white) (Kevin will
  // be the receiver)". Repeat until stable so multiple groups all go.
  s = s.replace(/\s*\([^)]*\)/g, ' ');
  s = s.replace(HONORIFIC, '');
  // "Camp Jubilee 2" / "Camp Jubilee 3" are the 2nd and 3rd machines on one
  // institutional account, not three different customers.
  s = s.replace(/\s+\d+\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

export type MatchConfidence = 'exact' | 'normalized' | 'ambiguous' | 'none';

export type NameMatchable = { id: string; full_name: string | null };

export type NameMatch = {
  customerId: string | null;
  confidence: MatchConfidence;
  /** Display names of every customer that tied, for the triage UI. Populated
   *  on 'ambiguous'; single-entry on a successful match; empty on 'none'. */
  candidates: string[];
};

const NO_MATCH: NameMatch = { customerId: null, confidence: 'none', candidates: [] };

/**
 * Resolve one unit's customer_name against the customer list.
 *
 * Only 'exact' and 'normalized' are safe to apply automatically. 'ambiguous'
 * means several customers normalise to the same string — the three near-duplicate
 * "Rongbin Sun" / "Rongbing Sun" records are the live example — and must go to a
 * human rather than be guessed at, because picking the wrong one silently
 * reassigns a machine.
 */
export function matchUnitToCustomer(
  unitName: string | null | undefined,
  customers: NameMatchable[],
): NameMatch {
  if (!unitName?.trim()) return NO_MATCH;

  // An exact (case-insensitive) hit wins outright, before any normalisation can
  // conflate two genuinely different people.
  const raw = unitName.trim().toLowerCase();
  const exact = customers.filter(c => (c.full_name ?? '').trim().toLowerCase() === raw);
  if (exact.length === 1) {
    return { customerId: exact[0].id, confidence: 'exact', candidates: [exact[0].full_name ?? ''] };
  }
  if (exact.length > 1) {
    return { customerId: null, confidence: 'ambiguous', candidates: exact.map(c => c.full_name ?? '') };
  }

  const target = normalizeCustomerName(unitName);
  if (!target) return NO_MATCH;

  const hits = customers.filter(c => normalizeCustomerName(c.full_name) === target);
  if (hits.length === 1) {
    return { customerId: hits[0].id, confidence: 'normalized', candidates: [hits[0].full_name ?? ''] };
  }
  if (hits.length > 1) {
    return { customerId: null, confidence: 'ambiguous', candidates: hits.map(c => c.full_name ?? '') };
  }
  return NO_MATCH;
}

/** True when a match may be written to `units.customer_id` without review. */
export function isAutoLinkable(m: NameMatch): boolean {
  return m.customerId !== null && (m.confidence === 'exact' || m.confidence === 'normalized');
}
