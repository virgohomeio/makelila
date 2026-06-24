import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { eventMeta, type CustomerEvent } from '../customerEvents';

// Per-customer buying-journey assembly (Marketing → Journey tab, Phase 1).
//
// Phase 1 stitches the journey from data we ALREADY store: the customer's
// first/last marketing touch (source + campaign, captured at order sync from
// the Shopify landing-site UTM), Lila-app engagement events, and their orders.
// It answers "where did they come from", "what was the last touch before they
// bought", "how long from first touch to purchase".
//
// What Phase 1 can NOT yet show — visit-by-visit web path (how many sessions
// before buying, the exact first/last page) — needs visit-level data we don't
// capture yet. Phase 2 adds a Shopify Customer-Journey pull + a Klaviyo
// email-event pull that feed the same touch list (see the roadmap note in the
// JourneyTab UI). buildJourney() is intentionally a pure merge over a touch
// array so those sources just append more touches later.

export type TouchKind = 'acquisition' | 'last_touch' | 'app' | 'order';

export type JourneyTouch = {
  at: string | null;
  kind: TouchKind;
  label: string;
  sub?: string | null;
  color: string;
};

export type CustomerTouchData = {
  first_touch_source: string | null;
  first_touch_campaign_id: string | null;
  first_touch_at: string | null;
  last_touch_source: string | null;
  last_touch_campaign_id: string | null;
  last_touch_at: string | null;
  klaviyo_profile_id: string | null;
  created_at: string | null;
};

export type JourneyOrder = {
  order_ref: string;
  placed_at: string | null;
  created_at: string | null;
  total_usd: number | null;
  currency: string | null;
  kind: string | null;
};

export type CustomerJourney = {
  firstSource: string | null;
  firstCampaign: string | null;
  firstTouchAt: string | null;
  lastSource: string | null;
  lastCampaign: string | null;
  lastTouchAt: string | null;
  firstOrderAt: string | null;
  orderCount: number;
  totalSpend: number;
  currency: string | null;
  daysFirstTouchToOrder: number | null;
  hasEmailProfile: boolean;
  touches: JourneyTouch[];
};

/** Normalize the many raw source strings (UTM free-text from Shopify, HubSpot
 *  enums, etc.) into a small set of human channel labels. */
export function prettySource(s: string | null | undefined): string {
  if (!s) return 'Unknown';
  const x = s.toLowerCase();
  if (x.includes('facebook') || x === 'fb' || x.includes('meta') || x.includes('paid_social')) return 'Facebook / Meta';
  if (x.includes('insta') || x === 'ig') return 'Instagram';
  if (x.includes('google') || x.includes('organic_search')) return 'Google';
  if (x.includes('tiktok')) return 'TikTok';
  if (x.includes('klaviyo') || x.includes('email')) return 'Email (Klaviyo)';
  if (x.includes('shopify') || x.includes('direct')) return 'Direct / Shopify';
  if (x.includes('hubspot')) return 'HubSpot (legacy)';
  if (x.includes('referral')) return 'Referral';
  return s;
}

function formatAmount(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${n.toFixed(0)}`;
  }
}

function tval(s: string | null): number {
  return s ? new Date(s).getTime() : Number.MAX_SAFE_INTEGER;
}

/** Pure merge of every known touch into one chronological journey + summary. */
export function buildJourney(
  touch: CustomerTouchData | null,
  orders: JourneyOrder[],
  events: CustomerEvent[],
): CustomerJourney {
  const touches: JourneyTouch[] = [];

  if (touch?.first_touch_source) {
    touches.push({
      at: touch.first_touch_at,
      kind: 'acquisition',
      label: `First touch · ${prettySource(touch.first_touch_source)}`,
      sub: touch.first_touch_campaign_id,
      color: '#2b6cb0',
    });
  }
  // Last touch only when it's a distinct event from the first.
  if (
    touch?.last_touch_source && touch.last_touch_at &&
    (touch.last_touch_at !== touch.first_touch_at || touch.last_touch_source !== touch.first_touch_source)
  ) {
    touches.push({
      at: touch.last_touch_at,
      kind: 'last_touch',
      label: `Last touch before order · ${prettySource(touch.last_touch_source)}`,
      sub: touch.last_touch_campaign_id,
      color: '#805ad5',
    });
  }
  for (const e of events) {
    const m = eventMeta(e.event_type);
    touches.push({ at: e.occurred_at, kind: 'app', label: m.label, color: m.color });
  }

  const sales = orders.filter(o => o.kind !== 'replacement');
  for (const o of sales) {
    touches.push({
      at: o.placed_at ?? o.created_at,
      kind: 'order',
      label: `Order ${o.order_ref}`,
      sub: o.total_usd != null ? formatAmount(o.total_usd, o.currency) : null,
      color: '#276749',
    });
  }

  touches.sort((a, b) => tval(a.at) - tval(b.at));

  const orderTimes = sales
    .map(o => o.placed_at ?? o.created_at)
    .filter((t): t is string => !!t)
    .sort();
  const firstOrderAt = orderTimes[0] ?? null;
  const totalSpend = sales.reduce((s, o) => s + (o.total_usd ?? 0), 0);
  const currency = sales.find(o => o.currency)?.currency ?? null;

  let daysFirstTouchToOrder: number | null = null;
  if (touch?.first_touch_at && firstOrderAt) {
    const d = (new Date(firstOrderAt).getTime() - new Date(touch.first_touch_at).getTime()) / 86_400_000;
    daysFirstTouchToOrder = d >= 0 ? Math.round(d) : null;
  }

  return {
    firstSource: touch?.first_touch_source ?? null,
    firstCampaign: touch?.first_touch_campaign_id ?? null,
    firstTouchAt: touch?.first_touch_at ?? null,
    lastSource: touch?.last_touch_source ?? null,
    lastCampaign: touch?.last_touch_campaign_id ?? null,
    lastTouchAt: touch?.last_touch_at ?? null,
    firstOrderAt,
    orderCount: sales.length,
    totalSpend,
    currency,
    daysFirstTouchToOrder,
    hasEmailProfile: !!touch?.klaviyo_profile_id,
    touches,
  };
}

/** The touch columns for one customer, fetched directly so this doesn't depend
 *  on the broad Customer type carrying them. */
export function useCustomerTouch(customerId: string | null) {
  const [touch, setTouch] = useState<CustomerTouchData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!customerId) { setTouch(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void supabase
      .from('customers')
      .select('first_touch_source, first_touch_campaign_id, first_touch_at, last_touch_source, last_touch_campaign_id, last_touch_at, klaviyo_profile_id, created_at')
      .eq('id', customerId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setTouch((data ?? null) as CustomerTouchData | null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [customerId]);

  return { touch, loading };
}

export type AcquisitionRow = { channel: string; count: number };

/** Acquisition-by-channel counts across all customers (first-touch source).
 *  Drives the overview at the top of the Journey tab. */
export function useAcquisitionOverview() {
  const [rows, setRows] = useState<AcquisitionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('customers')
      .select('first_touch_source')
      .then(({ data }) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        for (const r of (data ?? []) as { first_touch_source: string | null }[]) {
          const ch = r.first_touch_source ? prettySource(r.first_touch_source) : 'Unknown';
          m.set(ch, (m.get(ch) ?? 0) + 1);
        }
        setRows(
          Array.from(m.entries())
            .map(([channel, count]) => ({ channel, count }))
            .sort((a, b) => b.count - a.count),
        );
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { rows, loading };
}
