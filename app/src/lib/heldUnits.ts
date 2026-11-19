// "Which machines does this customer currently hold?"
//
// One definition, shared by the Customer Directory's list row and its detail
// panel. They previously hand-rolled this separately and disagreed: the row
// filtered to shipped units while the panel did not, so opening a customer
// listed machines the row had deliberately hidden as returned.

import type { Unit } from './stock';

/**
 * A unit counts as "held" only while shipped. `rework`, `scrap`, `ready` and
 * `team-test` all mean the machine is physically back with us — listing those
 * against a customer is what made replaced units linger in the directory after
 * a replacement went out.
 */
export function isHeld(u: Unit): boolean {
  return u.status === 'shipped';
}

export type HeldSerialIndex = {
  byId: Map<string, string[]>;
  byName: Map<string, string[]>;
};

/**
 * Pre-bucket held units by FK and by lowercased name, so a directory of
 * hundreds of customers doesn't re-scan every unit per row.
 *
 * The name bucket covers units the June 2026 backfill never linked. It is a
 * fallback, not a peer: a unit with a `customer_id` is indexed by that alone,
 * so a mis-typed name can't pull it under a second customer.
 */
export function buildHeldSerialIndex(units: Unit[]): HeldSerialIndex {
  const byId = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const u of units) {
    if (!isHeld(u)) continue;
    if (u.customer_id) {
      const arr = byId.get(u.customer_id);
      if (arr) arr.push(u.serial); else byId.set(u.customer_id, [u.serial]);
    } else if (u.customer_name) {
      const key = u.customer_name.toLowerCase();
      const arr = byName.get(key);
      if (arr) arr.push(u.serial); else byName.set(key, [u.serial]);
    }
  }
  return { byId, byName };
}

/**
 * Serials held by one customer: the union of their FK-linked units and any
 * name-matched ones.
 *
 * Union, not fall-through. The old `byId ?? byName` meant a customer with even
 * one FK-linked unit had their name-matched units silently dropped — which is
 * how Kevin Cheng's own machine stayed invisible behind a mis-linked one. A
 * customer can hold one of each while the backfill is only partly reconciled.
 *
 * `customers.serials` is deliberately not consulted anywhere: it is a snapshot
 * of the fulfilment sheet that only refreshes on a manual sync, so it
 * resurrects ownership operators have already corrected.
 */
export function serialsForCustomer(
  customer: { id: string; full_name: string | null },
  index: HeldSerialIndex,
): string[] {
  const byId = index.byId.get(customer.id) ?? [];
  const byName = index.byName.get(customer.full_name?.toLowerCase() ?? '') ?? [];
  if (byName.length === 0) return byId;
  return [...new Set([...byId, ...byName])];
}

/** The same rule, returning whole units — for the detail panel, which renders
 *  more than the serial. Kept here so the two views cannot drift apart again. */
export function heldUnitsForCustomer(
  customer: { id: string; full_name: string | null },
  units: Unit[],
): Unit[] {
  const lcName = customer.full_name?.toLowerCase() ?? '';
  return units.filter(u =>
    isHeld(u) && (u.customer_id
      ? u.customer_id === customer.id
      : u.customer_name?.toLowerCase() === lcName));
}
