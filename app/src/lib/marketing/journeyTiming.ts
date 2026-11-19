import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

// Purchase-timing + visit-history derived from the customer's Klaviyo events
// (pulled by klaviyo-pull-events into customer_events). Powers the Report's
// "Purchase Time after Purchase Visit" and the visit-history part of "Notes" —
// the numbers the operator used to read manually out of Klaviyo.

const SESSION_GAP_MS = 30 * 60 * 1000;   // >30 min idle = a new visit/session

type Ev = { t: number; type: string };

export type JourneySummary = { timeLabel: string | null; note: string | null };

/** All Klaviyo events grouped by customer, oldest-first. */
export function useKlaviyoJourneys(): { byCustomer: Map<string, Ev[]>; loading: boolean } {
  const [byCustomer, setByCustomer] = useState<Map<string, Ev[]>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('customer_events')
      .select('customer_id, event_type, occurred_at')
      .eq('source', 'klaviyo')
      .then(({ data, error }) => {
        if (cancelled) return;
        const m = new Map<string, Ev[]>();
        if (!error && data) {
          for (const r of data as Array<{ customer_id: string; event_type: string; occurred_at: string }>) {
            const t = new Date(r.occurred_at).getTime();
            if (!r.customer_id || !isFinite(t)) continue;
            (m.get(r.customer_id) ?? m.set(r.customer_id, []).get(r.customer_id)!).push({ t, type: r.event_type });
          }
          for (const list of m.values()) list.sort((a, b) => a.t - b.t);
        }
        setByCustomer(m);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { byCustomer, loading };
}

function fmtDelta(ms: number): string {
  if (ms < 60_000) return '1+ minute later';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}+ minute${m === 1 ? '' : 's'} later`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}+ hour${h === 1 ? '' : 's'} later`;
  const d = Math.floor(h / 24);
  return `${d}+ day${d === 1 ? '' : 's'} later`;
}

const isCart = (type: string) => /added_to_cart/.test(type);

// An on-site "visit" (browsing the store), as opposed to email opens/subscribes
// — those aren't visits. Used to anchor the purchase-after-visit time and to
// count real visits. (viewed_collection isn't synced today, but harmless here.)
const VISIT = /viewed_product|active_on_site|added_to_cart|started_checkout|viewed_collection/;

/** "Purchase Time after Purchase Visit" + a visit-history note, anchored on the
 *  real Shopify order time (`orderTimeMs`). The time is measured from the buyer's
 *  FIRST on-site visit to the purchase — e.g. Ken first viewed the product at
 *  2:09am and bought at 12:04pm → "9+ hours later" — NOT just the final checkout
 *  session. Only events up to the purchase count (a later re-engagement must
 *  never leak into an older order's timing/visit count). Returns nulls (caller
 *  shows UNKNOWN) when the buyer has NO on-site Klaviyo history before this order
 *  — e.g. orders before our Klaviyo events begin — so they read UNKNOWN, not a
 *  made-up number. */
export function summarizeJourney(events: Ev[] | undefined, orderTimeMs: number): JourneySummary {
  if (!events || events.length === 0) return { timeLabel: null, note: null };

  const purchase = orderTimeMs;
  // Pre-purchase history only (small buffer covers the order event's own clock skew).
  const history = events.filter(e => e.t <= purchase + 60_000);
  if (history.length === 0) return { timeLabel: null, note: null };   // no history before the order → UNKNOWN

  // The "purchase visit" is the buyer's FIRST on-site visit on the way to buying
  // (email opens don't count). Time = that visit → purchase.
  const visitEvents = history.filter(e => VISIT.test(e.type));
  const firstVisit = visitEvents[0];   // events are oldest-first
  const timeLabel = firstVisit ? fmtDelta(purchase - firstVisit.t) : null;

  // Visit count = on-site session clusters (>30 min idle = a new visit).
  let visits = 0;
  let last = -Infinity;
  for (const e of visitEvents) { if (e.t - last > SESSION_GAP_MS) visits++; last = e.t; }
  const anchor = firstVisit ?? history[0];
  const firstDate = new Date(anchor.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const carts = history.filter(e => isCart(e.type)).length;

  const bits = [visits > 0 ? `visited ${visits} time${visits === 1 ? '' : 's'} since ${firstDate}` : `first seen ${firstDate}`];
  if (carts) bits.push(`${carts} add-to-cart${carts === 1 ? '' : 's'}`);
  bits.push('then bought');
  return { timeLabel, note: bits.join(', ') };
}
