import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { classifyChannel } from './journey';
import type { Order } from '../orders';

// Auto sales-attribution report — the programmatic version of the manual
// "Late Spring Sale" tracker. Per-buyer rows + the KPI block (revenue, ad
// spend, CAC, ROAS, ROI, gross profit) assembled from Shopify orders + each
// customer's attribution + Meta ad spend. Columns that need session/ad-level
// tracking (visit counts, exact creative, "min after visit", age/gender) are
// out of scope here — they arrive with the Shopify Customer-Journey / Klaviyo
// event pulls.

export type SalesRow = {
  order_ref: string;
  name: string;
  placed_at: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  channel: string;
  campaign: string | null;
  referrer: string | null;
  // Purchase (last) visit source — the channel they came from when they bought.
  last_channel: string | null;
  last_referrer: string | null;
  plan: string;
  discount_codes: string[];
  revenue: number;
  currency: string;
  // Derived from the buyer's Klaviyo events (null when we have none).
  purchase_time: string | null;
  journey_note: string | null;
  // Best-effort from Meta's purchase demographics (null when not a clean match).
  age: string | null;
  gender: string | null;
  // Which campaign group this sale piled into (for verifying the bucketing).
  campaign_group: string | null;
};

export type Breakdown = { key: string; count: number; revenue: number };

export type SalesKpis = {
  sales: number;
  revenue: number;
  adSpendCad: number;
  cac: number | null;
  roas: number | null;
  roiPct: number | null;
  grossProfit: number;
  byChannel: Breakdown[];
  byProvince: Breakdown[];
  byPlan: Breakdown[];
  byDiscount: Breakdown[];
};

export type Attribution = { source: string | null; medium: string | null; campaign: string | null };

/** Buyer plan from the order's payment method / line items. We can tell Outright
 *  from financed (Sezzle); the exact 12 vs 36-month term isn't in our data. */
export function classifyPlan(o: Order): string {
  const pm = (o.payment_methods ?? []).map(s => s.toLowerCase());
  if (pm.some(p => p.includes('sezzle'))) return 'Financing (Sezzle)';
  const items = (o.line_items ?? []).map(li => ('name' in li ? li.name : '').toLowerCase());
  if (items.some(n => n.includes('month') || n.includes('financ') || n.includes('plan'))) return 'Financing';
  return 'Outright';
}

function bump(map: Map<string, Breakdown>, key: string, revenue: number) {
  const k = key || '—';
  const cur = map.get(k) ?? { key: k, count: 0, revenue: 0 };
  cur.count += 1;
  cur.revenue += revenue;
  map.set(k, cur);
}

const sortBreakdown = (m: Map<string, Breakdown>) => Array.from(m.values()).sort((a, b) => b.revenue - a.revenue);

export type JourneyInfo = { timeLabel: string | null; note: string | null };
export type Demo = { age: string | null; gender: string | null };

/** Build the report from sale orders + an attribution resolver + Meta spend.
 *  `journey` (optional) supplies the Klaviyo-derived purchase-time + visit note.
 *  `campaignName` (optional) turns a raw campaign value into a readable name.
 *  `demo` (optional) supplies the best-effort Meta age/gender for the buyer.
 *  `groupOf` (optional) supplies which campaign bucket the sale fell into. */
export function buildSalesReport(
  orders: Order[],
  resolve: (o: Order) => Attribution,
  adSpendCad: number,
  journey?: (o: Order) => JourneyInfo,
  campaignName?: (raw: string) => string | null,
  demo?: (o: Order) => Demo,
  groupOf?: (o: Order) => string | null,
): { rows: SalesRow[]; kpis: SalesKpis } {
  const sales = orders.filter(o => o.kind !== 'replacement');

  const byChannel = new Map<string, Breakdown>();
  const byProvince = new Map<string, Breakdown>();
  const byPlan = new Map<string, Breakdown>();
  const byDiscount = new Map<string, Breakdown>();

  const rows: SalesRow[] = sales.map(o => {
    const a = resolve(o);
    const channel = classifyChannel(a.source, a.medium);
    const plan = classifyPlan(o);
    const codes = o.discount_codes ?? [];
    const revenue = o.total_usd ?? 0;

    bump(byChannel, channel, revenue);
    bump(byProvince, o.region_state ?? '—', revenue);
    bump(byPlan, plan, revenue);
    if (codes.length === 0) bump(byDiscount, 'No code', revenue);
    else for (const c of codes) bump(byDiscount, c, revenue);

    return {
      order_ref: o.order_ref,
      name: o.customer_name,
      placed_at: o.placed_at ?? o.created_at,
      city: o.city ?? null,
      region: o.region_state ?? null,
      country: o.country ?? null,
      channel,
      campaign: a.campaign ? (campaignName ? campaignName(a.campaign) : a.campaign) : null,
      referrer: o.attribution_referrer ?? null,
      last_channel: o.attribution_last_source ? classifyChannel(o.attribution_last_source, o.attribution_last_medium) : null,
      last_referrer: o.attribution_last_referrer ?? null,
      plan,
      discount_codes: codes,
      revenue,
      currency: o.currency || 'USD',
      purchase_time: journey?.(o)?.timeLabel ?? null,
      journey_note: journey?.(o)?.note ?? null,
      age: demo?.(o)?.age ?? null,
      gender: demo?.(o)?.gender ?? null,
      campaign_group: groupOf?.(o) ?? null,
    };
  });

  // Newest sales first (most recent purchase at the top of the tracker).
  rows.sort((a, b) => (b.placed_at ?? '').localeCompare(a.placed_at ?? ''));

  const revenue = rows.reduce((s, r) => s + r.revenue, 0);
  const salesCount = rows.length;
  const cac = adSpendCad > 0 && salesCount > 0 ? +(adSpendCad / salesCount).toFixed(2) : null;
  const roas = adSpendCad > 0 ? +(revenue / adSpendCad).toFixed(2) : null;
  const grossProfit = revenue - adSpendCad;
  const roiPct = adSpendCad > 0 ? Math.round((grossProfit / adSpendCad) * 100) : null;

  return {
    rows,
    kpis: {
      sales: salesCount,
      revenue,
      adSpendCad,
      cac,
      roas,
      roiPct,
      grossProfit,
      byChannel: sortBreakdown(byChannel),
      byProvince: sortBreakdown(byProvince),
      byPlan: sortBreakdown(byPlan),
      byDiscount: sortBreakdown(byDiscount),
    },
  };
}

// Marker for any cell we can't populate from current data (age/gender demographics,
// exact ad creative, session timing). Shown greyed in the UI so it's obvious what
// still needs a data source rather than being silently blank.
export const UNKNOWN = 'UNKNOWN';

// Manual tracker columns, prefixed with a Campaign column so the bucketing each
// sale piled into is visible for verification.
export const REPORT_COLUMNS = [
  'Campaign', 'Name', 'Date', 'Time (EST)', 'City', 'Province/State', 'Country',
  'Age Range', 'Gender', 'Source', 'Buyer Plan',
  'Discount WELCOMELILA?', 'Discount CHECKOUTFIVE?', 'Other Codes?', 'Other Code 2',
  'Purchase Time after Purchase Visit', 'Notes',
] as const;

const COUNTRY_NAME: Record<string, string> = { US: 'United States', CA: 'Canada' };

function yesNo(codes: string[], code: string): string {
  return codes.includes(code) ? 'Yes' : 'No';
}

/** Friendly Source label; UNKNOWN when we have no attribution for the buyer. */
export function sourceLabel(channel: string): string {
  if (!channel || channel === 'Unknown' || channel === '—') return UNKNOWN;
  // The manual tracker wrote Facebook/Instagram paid simply as "Meta Ad".
  if (/^(Facebook|Instagram) Paid$/.test(channel) || channel === 'Paid Social') return 'Meta Ad';
  // Search engines: match Shopify's "google organic search" phrasing.
  if (channel === 'Google Organic' || channel === 'Bing Organic') return `${channel} Search`;
  return channel;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return url; }
}

// Friendly names for link-in-bio / referral hosts so they read as themselves.
const REFERRER_NAMES: Record<string, string> = {
  'linktr.ee': 'Linktree', 'linktree.com': 'Linktree',
  'beacons.ai': 'Beacons', 'bio.link': 'Bio Link', 'milkshake.app': 'Milkshake',
  'carrd.co': 'Carrd', 'taplink.cc': 'Taplink', 'komi.io': 'Komi',
};

/** Label a channel, naming the referring site when there is one:
 *   - a NAMED referral  → "Linktree" (or "Referral (someblog.com)")
 *   - no specific site  → "Direct"  (Shopify has no referrer → treat as direct)
 *  Non-referral channels (Meta Ad, Google Organic, Email, …) pass through.
 *  We only call it a Referral when we can say who referred them; otherwise it's
 *  effectively a direct visit. */
function labelWithSite(channel: string, referrer: string | null): string {
  const s = sourceLabel(channel);
  if (s !== 'Referral') return s;                 // Direct / Meta Ad / Google Organic / …
  const host = hostOf(referrer);
  if (!host || STORE_HOSTS.some(h => host.includes(h))) return 'Direct';   // no real referrer site
  return REFERRER_NAMES[host] ?? `Referral (${host})`;
}

// The store's own domains — a "referral" from these is internal navigation, NOT
// a real acquisition source, so it's treated like Direct.
const STORE_HOSTS = ['lilacomposter.com'];

/** A real acquisition source, or null for Direct / self-referral / unknown, so
 *  Direct is only ever a last resort. */
function realSource(label: string | null): string | null {
  if (!label || label === UNKNOWN || label === 'Direct') return null;
  if (STORE_HOSTS.some(h => label.toLowerCase().includes(h))) return null;
  return label;
}

function buildNote(r: SalesRow, source: string, secondary: string | null): string {
  const bits: string[] = [];
  if (source !== UNKNOWN) bits.push(`Saw ${source}`);
  if (secondary) bits.push(`also ${secondary}`);
  if (r.campaign) bits.push(`campaign ${r.campaign}`);
  // Visit history from Klaviyo when we have it; otherwise flag it's not captured.
  bits.push(r.journey_note ?? 'visit history UNKNOWN');
  // Exact ad creative (v21a…) can't be auto-detected — operator adds it manually.
  return bits.length ? bits.join('; ') : UNKNOWN;
}

/** One buyer row rendered as the 16 tracker columns. Shared by the table + CSV
 *  so they never drift. UNKNOWN marks a cell no current data source can fill. */
export function reportCells(r: SalesRow): string[] {
  const d = r.placed_at ? new Date(r.placed_at) : null;
  const date = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : UNKNOWN;
  const time = d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : UNKNOWN;
  const codes = r.discount_codes.map(c => c.toUpperCase());
  const others = codes.filter(c => c !== 'WELCOMELILA' && c !== 'CHECKOUTFIVE');
  // Source = the most meaningful real source across the first (acquisition) and
  // purchase (last) visits. Direct is only used when NO visit has a real source
  // (a self-referral off our own domain counts as internal, not a source).
  const firstLabel = labelWithSite(r.channel, r.referrer);
  const lastLabel = r.last_channel ? labelWithSite(r.last_channel, r.last_referrer) : null;
  const firstReal = realSource(firstLabel);
  const lastReal = realSource(lastLabel);
  const source = firstReal ?? lastReal
    ?? ((firstLabel === 'Direct' || lastLabel === 'Direct') ? 'Direct' : UNKNOWN);
  // A second distinct real source (e.g. first Meta Ad, purchase Linktree) → Notes.
  const secondary = firstReal && lastReal && firstReal !== lastReal
    ? (source === firstReal ? lastReal : firstReal)
    : null;
  return [
    r.campaign_group ?? '—',
    r.name,
    date,
    time,
    r.city || UNKNOWN,
    r.region || UNKNOWN,
    (r.country && COUNTRY_NAME[r.country]) || r.country || UNKNOWN,
    r.age && r.age.toLowerCase() !== 'unknown' ? r.age : UNKNOWN,       // best-effort from Meta
    r.gender && r.gender.toLowerCase() !== 'unknown'                    // best-effort from Meta
      ? r.gender.charAt(0).toUpperCase() + r.gender.slice(1).toLowerCase()
      : UNKNOWN,
    source,
    r.plan,
    yesNo(codes, 'WELCOMELILA'),
    yesNo(codes, 'CHECKOUTFIVE'),
    others[0] ?? 'No',
    others[1] ?? 'No',
    r.purchase_time ?? UNKNOWN,   // from the buyer's Klaviyo purchase-visit timing
    buildNote(r, source, secondary),
  ];
}

/** CSV of the full 16-column tracker (UNKNOWN where a source isn't wired yet). */
export function salesRowsToCsv(rows: SalesRow[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map(r => reportCells(r).map(esc).join(','));
  return [REPORT_COLUMNS.join(','), ...lines].join('\n');
}

/** Attribution per customer (by id + email) so each order resolves its source. */
export function useCustomerAttribution() {
  const [byId, setById] = useState<Map<string, Attribution>>(new Map());
  const [byEmail, setByEmail] = useState<Map<string, Attribution>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('customers')
      .select('id, email, first_touch_source, first_touch_medium, first_touch_campaign_id')
      .then(({ data }) => {
        if (cancelled) return;
        const id = new Map<string, Attribution>();
        const em = new Map<string, Attribution>();
        for (const r of (data ?? []) as Array<{ id: string; email: string | null; first_touch_source: string | null; first_touch_medium: string | null; first_touch_campaign_id: string | null }>) {
          const a: Attribution = { source: r.first_touch_source, medium: r.first_touch_medium, campaign: r.first_touch_campaign_id };
          id.set(r.id, a);
          if (r.email) em.set(r.email.toLowerCase(), a);
        }
        setById(id); setByEmail(em); setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { byId, byEmail, loading };
}
