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
  if (ms < 60_000) return 'under a minute later';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}+ minute${m === 1 ? '' : 's'} later`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}+ hour${h === 1 ? '' : 's'} later`;
  const d = Math.floor(h / 24);
  return `${d}+ day${d === 1 ? '' : 's'} later`;
}

const isOrder = (type: string) => /placed_order|ordered_product/.test(type);
const isCart  = (type: string) => /added_to_cart/.test(type);

/** Time-to-purchase within the buying session + a visit-history note. Returns
 *  nulls when there are no events (caller shows UNKNOWN). `orderTimeMs` anchors
 *  which "placed order" event this order corresponds to. */
export function summarizeJourney(events: Ev[] | undefined, orderTimeMs: number): JourneySummary {
  if (!events || events.length === 0) return { timeLabel: null, note: null };

  // The purchase = the "placed order" event nearest this order's timestamp
  // (a customer may have several orders); fall back to the order time itself.
  const orders = events.filter(e => isOrder(e.type));
  const purchase = orders.length
    ? orders.reduce((best, e) => (Math.abs(e.t - orderTimeMs) < Math.abs(best.t - orderTimeMs) ? e : best)).t
    : orderTimeMs;

  // Session start = walk back from the purchase while gaps stay under 30 min.
  const pre = events.filter(e => e.t <= purchase + 60_000);
  let sessionStart = purchase;
  for (let i = pre.length - 1; i >= 0; i--) {
    if (pre[i].t > purchase) continue;
    if (sessionStart - pre[i].t <= SESSION_GAP_MS) sessionStart = pre[i].t;
    else break;
  }
  const timeLabel = fmtDelta(purchase - sessionStart);

  // Visit count = number of session clusters across all events.
  let visits = 0;
  let last = -Infinity;
  for (const e of events) { if (e.t - last > SESSION_GAP_MS) visits++; last = e.t; }
  const firstVisit = new Date(events[0].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const carts = events.filter(e => isCart(e.type)).length;

  const bits = [`visited ${visits} time${visits === 1 ? '' : 's'} since ${firstVisit}`];
  if (carts) bits.push(`${carts} add-to-cart${carts === 1 ? '' : 's'}`);
  bits.push('then bought');
  return { timeLabel, note: bits.join(', ') };
}
