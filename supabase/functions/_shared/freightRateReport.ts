// The arithmetic behind the Freightcom rate-probe report.
// Spec: docs/superpowers/specs/2026-09-22-freightcom-rate-probe-design.md
//
// Deno-free on purpose, like _shared/freightcom.ts next to it:
// app/src/lib/freightRateReport.test.ts imports this module directly, which is
// the only way any of it gets tested — the edge functions themselves run
// untested against the live API.
//
// Everything here is CAD. Freightcom quotes CAD for US destinations as well as
// Canadian ones on this account, so no conversion happens anywhere in the
// probe, and a rate that came back in another currency is carried as null
// rather than as a number in the wrong units.

export const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** Operator-set thresholds on the cheapest rate for a shipment. */
export const WARN_CAD     = 150;
export const CRITICAL_CAD = 200;

export type FlagLevel = 'none' | 'warn' | 'critical';

/** Strictly greater than: "flag anything over $150" does not flag $150 itself. */
export function flagFor(rate: number | null): FlagLevel {
  if (rate === null || !Number.isFinite(rate)) return 'none';
  if (rate > CRITICAL_CAD) return 'critical';
  if (rate > WARN_CAD) return 'warn';
  return 'none';
}

export type ProbeRow = {
  order_id: string;
  order_ref: string;
  customer_name: string;
  dest_postal: string;
  dest_country: string;
  ship_date: string;
  ship_weekday: number;
  run_index: number;
  rate_cad: number | null;
};

/** One row per (order, ship date, run). The probe marks every carrier that ties
 *  for cheapest, so a tie would otherwise weight that day twice in the average. */
export function dedupe<T extends ProbeRow>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.order_id}|${r.ship_date}|${r.run_index}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

/** Average cheapest rate per weekday, cheapest weekday first.
 *
 *  Averaged rather than minimised on purpose. Absolute rates differ by an order
 *  of magnitude between a Toronto delivery and a rural Newfoundland one
 *  ($36.43 vs $125.52 for the same box, measured 2026-09-10), so the minimum
 *  across customers would only ever re-find the nearest customer. The question
 *  is whether a weekday is systematically cheaper, which is a question about
 *  the average. */
export function averageByWeekday(rows: ProbeRow[]): Array<{ day: number; avg: number; n: number }> {
  const acc = new Map<number, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.rate_cad === null) continue;
    const a = acc.get(r.ship_weekday) ?? { sum: 0, n: 0 };
    a.sum += r.rate_cad;
    a.n += 1;
    acc.set(r.ship_weekday, a);
  }
  return [...acc.entries()]
    .map(([day, a]) => ({ day, avg: a.sum / a.n, n: a.n }))
    .sort((x, y) => x.avg - y.avg);
}

export type BestRate = {
  order_id: string;
  order_ref: string;
  customer_name: string;
  postal: string;
  rate: number;
  weekday: number;
  ship_date: string;
};

/** Each order's cheapest rate across every ship date sampled, dearest first.
 *
 *  This is what the flags are applied to. A customer whose best possible day
 *  still costs over $200 is a different problem from one who is merely
 *  expensive on a Friday, and only the first needs anyone to do something. */
export function bestRatePerOrder(rows: ProbeRow[]): BestRate[] {
  const best = new Map<string, BestRate>();
  for (const r of rows) {
    if (r.rate_cad === null) continue;
    const cur = best.get(r.order_id);
    if (!cur || r.rate_cad < cur.rate) {
      best.set(r.order_id, {
        order_id: r.order_id,
        order_ref: r.order_ref,
        customer_name: r.customer_name,
        postal: `${r.dest_postal} ${r.dest_country}`,
        rate: r.rate_cad,
        weekday: r.ship_weekday,
        ship_date: r.ship_date,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.rate - a.rate);
}

export type Drift = {
  order_ref: string; customer_name: string;
  first: number; last: number; pct: number;
};

/** Compares like with like: each order's cheapest rate in the first run against
 *  its cheapest in the latest, largest move first. Orders missing from either
 *  run are skipped rather than counted as a change. */
export function driftSince(all: ProbeRow[], firstRun: number, lastRun: number): Drift[] {
  if (firstRun === lastRun) return [];
  const minBy = (run: number) => {
    const m = new Map<string, { rate: number; ref: string; name: string }>();
    for (const r of all) {
      if (r.run_index !== run || r.rate_cad === null) continue;
      const cur = m.get(r.order_id);
      if (!cur || r.rate_cad < cur.rate) {
        m.set(r.order_id, { rate: r.rate_cad, ref: r.order_ref, name: r.customer_name });
      }
    }
    return m;
  };
  const a = minBy(firstRun), b = minBy(lastRun);
  const out: Drift[] = [];
  for (const [id, first] of a) {
    const last = b.get(id);
    if (!last || first.rate === 0) continue;
    const change = ((last.rate - first.rate) / first.rate) * 100;
    if (Math.abs(change) < 0.01) continue;
    out.push({ order_ref: first.ref, customer_name: first.name, first: first.rate, last: last.rate, pct: change });
  }
  return out.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
}

/** California by ZIP range (90001–96162). The probe stores the postal code it
 *  actually rated, which for a verified mismatch is the postal authority's code
 *  rather than the customer's — so this reads the destination the parcel would
 *  really go to. */
export function isCalifornia(row: { dest_country: string; dest_postal: string }): boolean {
  if (row.dest_country !== 'US') return false;
  const z = parseInt(row.dest_postal.slice(0, 5), 10);
  return Number.isFinite(z) && z >= 90001 && z <= 96162;
}

export function money(n: number): string { return `$${n.toFixed(2)}`; }
export function signed(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(1)}`; }

/** How far `low` sits below `high`, as a percentage of `high`. */
export function pctBelow(low: number, high: number): string {
  if (!(high > 0)) return '0.0%';
  return `${(((high - low) / high) * 100).toFixed(1)}%`;
}
