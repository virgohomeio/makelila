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
  plan: string;
  discount_codes: string[];
  revenue: number;
  currency: string;
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

/** Build the report from sale orders + an attribution resolver + Meta spend. */
export function buildSalesReport(
  orders: Order[],
  resolve: (o: Order) => Attribution,
  adSpendCad: number,
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
      campaign: a.campaign,
      plan,
      discount_codes: codes,
      revenue,
      currency: o.currency || 'USD',
    };
  });

  rows.sort((a, b) => (a.placed_at ?? '').localeCompare(b.placed_at ?? ''));

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

/** CSV mirroring the manual tracker's per-buyer columns (the ones we can fill). */
export function salesRowsToCsv(rows: SalesRow[]): string {
  const head = ['Name', 'Date', 'City', 'Province/State', 'Country', 'Channel', 'Campaign', 'Plan', 'Discount Codes', 'Revenue', 'Currency'];
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map(r => [
    r.name,
    r.placed_at ? new Date(r.placed_at).toLocaleDateString('en-CA') : '',
    r.city ?? '', r.region ?? '', r.country ?? '',
    r.channel, r.campaign ?? '', r.plan,
    r.discount_codes.join(' + '),
    r.revenue.toFixed(2), r.currency,
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
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
