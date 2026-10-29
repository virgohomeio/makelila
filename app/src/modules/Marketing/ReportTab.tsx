import { useMemo, useState, type CSSProperties } from 'react';
import { useAllOrders, type Order } from '../../lib/orders';
import { useFbCampaigns, useFbDemographics, useFbAds, type FbCampaign } from '../../lib/marketing/facebook';
import {
  buildSalesReport, salesRowsToCsv, reportCells, REPORT_COLUMNS, UNKNOWN,
  useCustomerAttribution, isTestOrder, isRealSale, type Attribution, type Demo,
} from '../../lib/marketing/salesReport';
import { useKlaviyoJourneys, summarizeJourney } from '../../lib/marketing/journeyTiming';
import { buildCampaignGroups } from '../../lib/marketing/campaignGroups';
import { useGoogleAds, sumGoogleAds } from '../../lib/marketing/googleAds';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// Date-range options for the report's KPI/summary + order list. 'all' = every
// sale; 'today'/'yesterday' = that single EST calendar day; the numeric keys are
// rolling windows of N calendar days ending today (inclusive).
const RANGES: { key: string; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7', label: 'Last 7 days' },
  { key: '14', label: 'Last 14 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '60', label: 'Last 60 days' },
  { key: '90', label: 'Last 90 days' },
  { key: '365', label: 'Last 365 days' },
  { key: 'custom', label: 'Custom range…' },
];

// fb_ads holds ~120 days of daily ad-level rows, so any window whose start is
// within this many days is fully covered there (accurate per-day Meta spend);
// older/unbounded windows fall back to the lifetime fb_campaigns totals.
const FB_ADS_COVERAGE_DAYS = 120;

/** The creative code an operator recognises (v28a, v13a…) pulled out of a Meta
 *  ad name or a utm_content string. Prefers a code WITH a trailing letter — an
 *  ad VERSION like "v1" has none — so "Fall 2026 v1 - v28a" → "v28a". Takes the
 *  last such code; null when there's no recognisable creative code. */
function creativeLabel(s: string | null): string | null {
  if (!s) return null;
  const lettered = [...s.matchAll(/\bv\d+[a-z]\b/gi)];
  if (lettered.length) return lettered[lettered.length - 1][0].toLowerCase();
  const any = [...s.matchAll(/\bv\d+[a-z]?\b/gi)];
  if (any.length) return any[any.length - 1][0].toLowerCase();
  return null;
}

export function ReportTab() {
  const { orders, loading: ordersLoading } = useAllOrders();
  const { byId, byEmail } = useCustomerAttribution();
  const { byCustomer: journeys } = useKlaviyoJourneys();
  const { campaigns } = useFbCampaigns(365);
  const { demographics } = useFbDemographics();
  const { ads } = useFbAds();
  const { rows: googleRows } = useGoogleAds();
  const [rangeKey, setRangeKey] = useState('all');   // default: All time — show every sale
  const [customStart, setCustomStart] = useState('');   // YYYY-MM-DD, used when rangeKey === 'custom'
  const [customEnd, setCustomEnd] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);

  // The selected date window as inclusive EST YYYY-MM-DD bounds (null = unbounded
  // = all time). `daily` says the window is short enough to source Meta spend
  // from fb_ads (daily) rather than the lifetime fb_campaigns totals.
  const dayStr = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const range = useMemo(() => {
    const now = Date.now();
    const today = dayStr(now);
    // Earliest day fb_ads still covers — a window starting on/after it can use
    // the accurate daily rows; an earlier start falls back to lifetime totals.
    const coverFrom = dayStr(now - FB_ADS_COVERAGE_DAYS * 86_400_000);
    if (rangeKey === 'all') return { start: null as string | null, end: null as string | null, daily: false };
    if (rangeKey === 'custom') {
      if (!customStart && !customEnd) return { start: null as string | null, end: null as string | null, daily: false };
      // Allow start or end alone; order them defensively if both given reversed.
      let s = customStart || '0000-01-01';
      let e = customEnd || today;
      if (s > e) { const t = s; s = e; e = t; }
      return { start: s, end: e, daily: s >= coverFrom };
    }
    if (rangeKey === 'today') return { start: today, end: today, daily: true };
    if (rangeKey === 'yesterday') { const y = dayStr(now - 86_400_000); return { start: y, end: y, daily: true }; }
    const n = Number(rangeKey);
    const start = dayStr(now - (n - 1) * 86_400_000);
    return { start, end: today, daily: n <= FB_ADS_COVERAGE_DAYS };
  }, [rangeKey, customStart, customEnd]);

  const inRange = (iso: string | null | undefined) => {
    if (!range.start) return true;               // all time
    if (!iso) return false;
    const d = dayStr(new Date(iso).getTime());
    return d >= range.start && d <= range.end!;
  };

  // Curated sale groups (each = many Meta campaigns), piled chronologically:
  // each group's window runs from its earliest Meta start until the NEXT group
  // starts — so a sale in the gap after a sale ended still counts to that (the
  // last active) group.
  const campaignGroups = useMemo(() => buildCampaignGroups(campaigns), [campaigns]);
  const selectedGroup = campaignFilter === 'all' ? null : (campaignGroups.find(g => g.key === campaignFilter) ?? null);

  // Order's calendar day in EST (matches the displayed Date/Time) for comparing
  // against the campaign windows' inclusive YYYY-MM-DD boundaries.
  const estDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const inScope = (o: Order) => {
    if (selectedGroup) {
      const d = estDate(o.placed_at ?? o.created_at);
      return d >= selectedGroup.startDate && (!selectedGroup.endDate || d <= selectedGroup.endDate);
    }
    return inRange(o.placed_at ?? o.created_at);
  };

  // Defensive: collapse fb_campaigns to one row per Meta campaign_id so any
  // stray duplicate lifetime row can never double-count ad spend. (The sync
  // also guards against dupes; this makes the report safe regardless.)
  const uniqueCampaigns = useMemo(() => {
    const m = new Map<string, FbCampaign>();
    const noId: FbCampaign[] = [];
    for (const c of campaigns) {
      if (!c.campaign_id) { noId.push(c); continue; }
      const prev = m.get(c.campaign_id);
      if (!prev || (c.spend_cad ?? 0) >= (prev.spend_cad ?? 0)) m.set(c.campaign_id, c);
    }
    return [...m.values(), ...noId];
  }, [campaigns]);

  // Per-platform spend + conversions for the selected scope: Meta and Google
  // (google_ads_campaigns), separate and blended. Conversions are each platform's
  // OWN reported conversions (Meta website purchases, Google conversions). Total
  // ad spend here drives the blended CAC/ROAS/ROI below.
  //
  // Meta source depends on the window: a campaign GROUP or an unbounded / long
  // (>120-day) window uses the lifetime fb_campaigns totals; a short bounded
  // window (today … last 90 days) uses the daily ad-level fb_ads rows so spend +
  // conversions reflect exactly that date range (fb_campaigns has no daily
  // breakdown — its date_start is a lifetime boundary, so it can't be filtered).
  const platform = useMemo(() => {
    let metaSpend = 0;
    let metaConversions = 0;
    let metaValue = 0;   // Meta's own reported purchase value → Meta ROAS.
    if (selectedGroup) {
      const gc = uniqueCampaigns.filter(c => c.campaign_id && selectedGroup.ids.has(c.campaign_id));
      metaSpend = gc.reduce((s, c) => s + (c.spend_cad ?? 0), 0);
      metaConversions = gc.reduce((s, c) => s + (c.metrics?.website_purchases ?? 0), 0);
      metaValue = gc.reduce((s, c) => s + (c.metrics?.website_purchases_value ?? 0), 0);
    } else if (range.daily && range.start) {
      // Short bounded window → sum daily ad-level rows within [start, end].
      for (const ad of ads) {
        if (!ad.date_start) continue;
        const d = ad.date_start.slice(0, 10);
        if (d < range.start || d > range.end!) continue;
        metaSpend += ad.spend_cad ?? 0;
        metaConversions += ad.purchases ?? 0;
        metaValue += ad.purchases_value ?? 0;
      }
    } else {
      // All time, or a window too long for fb_ads coverage → lifetime totals.
      metaSpend = uniqueCampaigns.reduce((s, c) => s + (c.spend_cad ?? 0), 0);
      metaConversions = uniqueCampaigns.reduce((s, c) => s + (c.metrics?.website_purchases ?? 0), 0);
      metaValue = uniqueCampaigns.reduce((s, c) => s + (c.metrics?.website_purchases_value ?? 0), 0);
    }
    // Google date window, aligned to the selected group / range.
    const gStart = selectedGroup ? selectedGroup.startDate : range.start;
    const gEnd = selectedGroup ? (selectedGroup.endDate ?? dayStr(Date.now())) : range.end;
    const g = sumGoogleAds(googleRows, gStart, gEnd);
    // Per-platform ROAS = that platform's OWN reported conversion value / spend.
    return {
      metaSpend, metaConversions, metaCac: metaConversions ? metaSpend / metaConversions : null,
      metaValue, metaRoas: metaSpend && metaValue ? metaValue / metaSpend : null,
      googleSpend: g.spend, googleConversions: g.conversions, googleValue: g.value, googleHasData: g.hasData,
      googleCac: g.conversions ? g.spend / g.conversions : null,
      googleRoas: g.spend && g.value ? g.value / g.spend : null,
      totalSpend: metaSpend + g.spend,
      totalConversions: metaConversions + g.conversions,
    };
  }, [uniqueCampaigns, ads, selectedGroup, range, googleRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const { rows, kpis } = useMemo(() => {
    const filtered = orders.filter(o => o.kind !== 'replacement' && !isTestOrder(o) && isRealSale(o) && inScope(o));
    const resolve = (o: Order): Attribution =>
      // Prefer the order's own Shopify attribution (google organic, meta, …);
      // fall back to the customer's first-touch, then unknown.
      (o.attribution_source
        ? { source: o.attribution_source, medium: o.attribution_medium, campaign: o.attribution_campaign }
        : undefined) ??
      (o.customer_id ? byId.get(o.customer_id) : undefined) ??
      (o.customer_email ? byEmail.get(o.customer_email.toLowerCase()) : undefined) ??
      { source: null, medium: null, campaign: null };
    const journey = (o: Order) => {
      if (!o.customer_id) return { timeLabel: null, note: null };
      const orderMs = new Date(o.placed_at ?? o.created_at).getTime();
      return summarizeJourney(journeys.get(o.customer_id), orderMs);
    };
    // Resolve a raw campaign value to a readable name: Meta campaign id → its
    // name; underscores/hyphens → spaces; a bare unmatched number → dropped.
    const fbNames = new Map(campaigns.filter(c => c.campaign_id && c.campaign_name).map(c => [String(c.campaign_id), c.campaign_name]));
    const campaignName = (raw: string): string | null => {
      const named = fbNames.get(String(raw));
      if (named) return named;
      if (/^\d+$/.test(raw)) return null;
      return raw.replace(/[_-]+/g, ' ').trim();
    };

    // Best-effort Age/Gender: match a sale to a Meta purchase segment only when
    // it's unambiguous — the day+country had exactly ONE Shopify sale AND Meta
    // shows exactly ONE purchase in a single age×gender segment. Else UNKNOWN.
    // Age×gender purchase segments per day (country is a separate breakdown now).
    const demoByDate = new Map<string, Map<string, number>>();
    for (const d of demographics) {
      if (!d.purchases) continue;
      if (d.age === 'all' || d.gender === 'all') continue;         // only age×gender rows
      if (/\bmini\b/i.test(d.campaign_name ?? '')) continue;        // Mini = Shopline, not a Shopify sale
      const seg = `${d.age}|${d.gender}`;
      const m = demoByDate.get(d.date) ?? new Map<string, number>();
      m.set(seg, (m.get(seg) ?? 0) + (d.purchases ?? 0));
      demoByDate.set(d.date, m);
    }
    const salesByDate = new Map<string, number>();
    for (const o of orders) {
      if (o.kind === 'replacement' || isTestOrder(o) || !isRealSale(o)) continue;
      const dt = estDate(o.placed_at ?? o.created_at);
      salesByDate.set(dt, (salesByDate.get(dt) ?? 0) + 1);
    }
    const demo = (o: Order): Demo => {
      const dt = estDate(o.placed_at ?? o.created_at);
      const segs = demoByDate.get(dt);
      if (!segs) return { age: null, gender: null };
      const total = Array.from(segs.values()).reduce((a, b) => a + b, 0);
      const distinct = Array.from(segs.entries()).filter(([, v]) => v > 0);
      const sales = salesByDate.get(dt) ?? 0;
      if (sales === 1 && total === 1 && distinct.length === 1) {
        const [age, gender] = distinct[0][0].split('|');
        return { age, gender };
      }
      return { age: null, gender: null };
    };

    // Best-effort exact ad creative: the SAME clean-day match as age/gender, but
    // over Meta's per-ad purchases — if a day had exactly ONE Shopify sale AND
    // exactly ONE creative recorded exactly ONE purchase that day, that's the
    // creative the buyer saw (e.g. "v20c"). Exclude Mini (Shopline, not Shopify).
    const creativeByDate = new Map<string, Map<string, number>>();
    for (const ad of ads) {
      if (!ad.date_start || !ad.purchases) continue;
      if (/\bmini\b/i.test(ad.campaign_name ?? '')) continue;
      const label = creativeLabel(ad.ad_name);
      if (!label) continue;
      const m = creativeByDate.get(ad.date_start) ?? new Map<string, number>();
      m.set(label, (m.get(label) ?? 0) + (ad.purchases ?? 0));
      creativeByDate.set(ad.date_start, m);
    }
    // utm_content is sometimes the creative string ("Fall 2026 v1 - v28a") and
    // sometimes the numeric Meta ad id (e.g. 120250118728320739). Map ad id → ad
    // name via fb_ads so either form resolves to the creative code.
    const adNameById = new Map<string, string>();
    for (const ad of ads) if (ad.ad_id && ad.ad_name) adNameById.set(ad.ad_id, ad.ad_name);
    const creativeFromContent = (content: string | null): string | null => {
      const direct = creativeLabel(content);
      if (direct) return direct;
      const id = (content ?? '').trim();
      if (/^\d+$/.test(id)) return creativeLabel(adNameById.get(id) ?? null);
      return null;
    };
    const creativeOf = (o: Order): string | null => {
      // Deterministic first: the ad creative from the order's OWN utm_content —
      // either the creative string or the Meta ad id (resolved via fb_ads).
      const fromContent = creativeFromContent(o.attribution_content);
      if (fromContent) return fromContent;
      // Fallback for older orders with no utm_content: the best-effort clean-day
      // match from Meta's per-ad purchases.
      const dt = estDate(o.placed_at ?? o.created_at);
      const dayAds = creativeByDate.get(dt);
      if (!dayAds) return null;
      const total = Array.from(dayAds.values()).reduce((a, b) => a + b, 0);
      const distinct = Array.from(dayAds.entries()).filter(([, v]) => v > 0);
      const sales = salesByDate.get(dt) ?? 0;
      if (sales === 1 && total === 1 && distinct.length === 1) return distinct[0][0];
      return null;
    };

    // Which campaign bucket each sale piled into (shown in the Campaign column).
    const groupOf = (o: Order): string | null => {
      const d = estDate(o.placed_at ?? o.created_at);
      const g = campaignGroups.find(gr => d >= gr.startDate && (!gr.endDate || d <= gr.endDate));
      return g ? g.label : null;
    };

    return buildSalesReport(filtered, resolve, platform.totalSpend, journey, campaignName, demo, groupOf, creativeOf);
  }, [orders, byId, byEmail, journeys, campaigns, campaignGroups, demographics, ads, platform, range, campaignFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pagedRows = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const downloadCsv = () => {
    const blob = new Blob([salesRowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={campaignFilter} onChange={e => { setCampaignFilter(e.target.value); setPage(0); }} style={{ ...selectStyle, maxWidth: 360 }}>
          <option value="all">All campaigns</option>
          {[...campaignGroups].reverse().map(g => (
            <option key={g.key} value={g.key}>{g.label}</option>
          ))}
        </select>
        <select value={rangeKey} onChange={e => { setRangeKey(e.target.value); setPage(0); }} style={selectStyle} disabled={campaignFilter !== 'all'}>
          {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        {rangeKey === 'custom' && campaignFilter === 'all' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customStart} max={customEnd || undefined}
              onChange={e => { setCustomStart(e.target.value); setPage(0); }} style={selectStyle} title="Start date" />
            <span style={{ fontSize: 12, color: muted }}>→</span>
            <input type="date" value={customEnd} min={customStart || undefined}
              onChange={e => { setCustomEnd(e.target.value); setPage(0); }} style={selectStyle} title="End date" />
          </span>
        )}
        <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }} style={selectStyle} title="Rows per page">
          {[20, 40, 60, 80, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <button onClick={downloadCsv} disabled={rows.length === 0} style={btnStyle}>↓ Download CSV</button>
        {selectedGroup && (
          <span style={{ fontSize: 11, color: muted }}>
            {new Date(selectedGroup.startDate + 'T12:00:00').toLocaleDateString('en-CA', { dateStyle: 'medium' })}
            {' → '}
            {selectedGroup.endDate ? new Date(selectedGroup.endDate + 'T12:00:00').toLocaleDateString('en-CA', { dateStyle: 'medium' }) : 'today'}
          </span>
        )}
        {kpis.adSpendCad === 0 && !selectedGroup && (
          <span style={{ fontSize: 11, color: muted }}>Ad spend $0 — connect Meta to fill CAC/ROAS/ROI.</span>
        )}
      </div>

      {/* Combined KPI block — blended across Meta + Google ad spend. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <Kpi label="Total sales" value={String(kpis.sales)} />
        <Kpi label="Revenue" value={money(kpis.revenue)} />
        <Kpi label="Ad spend — total (CAD)" value={money(platform.totalSpend)} />
        <Kpi label="Blended CAC" value={kpis.cac != null ? money(kpis.cac) : '—'} />
        <Kpi label="ROAS" value={kpis.roas != null ? `${kpis.roas.toFixed(2)}×` : '—'} />
        <Kpi label="ROI" value={kpis.roiPct != null ? `${kpis.roiPct}%` : '—'} />
        <Kpi label="Gross profit" value={money(kpis.grossProfit)} />
      </div>

      {/* Per-platform split — each platform's own spend + reported conversions + CAC. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <PlatformCard name="Meta ads" spend={platform.metaSpend} conversions={platform.metaConversions} cac={platform.metaCac} roas={platform.metaRoas}
          note={platform.metaSpend === 0 ? 'no spend in this window' : undefined} />
        <PlatformCard name="Google ads" spend={platform.googleSpend} conversions={platform.googleConversions} cac={platform.googleCac} roas={platform.googleRoas}
          note={!platform.googleHasData ? 'no spend in this window' : undefined} />
      </div>

      <div style={{ fontSize: 11, color: muted, marginBottom: 14 }}>
        One row per buyer, mirroring the manual Sale tracker. <strong>Ad spend, CAC, ROAS, ROI</strong> above are blended
        across Meta + Google; the per-platform split (each platform's own reported conversions) sits right under them.
        <strong>Purchase time</strong> + visit history are auto-filled
        from Klaviyo. The exact <strong>ad creative</strong> (v28a…) in Notes comes from the order's own Shopify
        <strong>utm_content</strong> when present (deterministic), otherwise a best-effort Meta clean-day match.
        <strong>Age / Gender</strong> are best-effort from Meta's purchase demographics — filled only on an unambiguous
        single-sale day. Operator-tracked creative still overrides. Run Sync All to populate.
      </div>

      {/* Per-buyer table — exact tracker columns */}
      {ordersLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 18 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}>
                {REPORT_COLUMNS.map(c => <th key={c} style={{ padding: '8px 10px', background: 'var(--color-surface)' }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map(r => (
                <tr key={r.order_ref} style={{ borderTop: '1px solid var(--color-border)' }}>
                  {reportCells(r).map((cell, i) => (
                    <td key={i} style={{
                      padding: '7px 10px',
                      color: cell === UNKNOWN ? subtle : 'inherit',
                      fontStyle: cell === UNKNOWN ? 'italic' : 'normal',
                      fontWeight: i === 0 ? 600 : 400,
                    }}>{cell}</td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={REPORT_COLUMNS.length} style={{ padding: 12, color: subtle }}>No sales in this window.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: muted, marginRight: 6 }}>
            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, rows.length)} of {rows.length}
          </span>
          <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} style={pageBtn}>‹ Prev</button>
          {pageWindow(safePage, pageCount).map((p, i) => p === -1
            ? <span key={`e${i}`} style={{ fontSize: 12, color: subtle, padding: '0 2px' }}>…</span>
            : <button key={p} onClick={() => setPage(p)} style={p === safePage ? pageBtnActive : pageBtn}>{p + 1}</button>,
          )}
          <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} style={pageBtn}>Next ›</button>
        </div>
      )}

      {/* Breakdowns */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        <BreakdownTable title="By channel" rows={kpis.byChannel} />
        <BreakdownTable title="By plan" rows={kpis.byPlan} />
        <BreakdownTable title="By province/state" rows={kpis.byProvince} />
        <BreakdownTable title="By discount code" rows={kpis.byDiscount} />
      </div>
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: { key: string; count: number; revenue: number }[] }) {
  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '4px 0' }}>{r.key}</td>
              <td style={{ textAlign: 'right', color: muted }}>{r.count}</td>
              <td style={{ textAlign: 'right' }}>{money(r.revenue)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td style={{ color: subtle, padding: '4px 0' }}>—</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 14px', minWidth: 110 }}>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function PlatformCard({ name, spend, conversions, cac, roas, note }: {
  name: string; spend: number; conversions: number; cac: number | null; roas: number | null; note?: string;
}) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 14px', minWidth: 300 }}>
      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 5 }}>{name}</div>
      <div style={{ display: 'flex', gap: 18 }}>
        <PlatformStat label="Spend (CAD)" value={money(spend)} />
        <PlatformStat label="Conversions" value={String(conversions)} />
        <PlatformStat label="CAC" value={cac != null ? money(cac) : '—'} />
        <PlatformStat label="ROAS" value={roas != null ? `${roas.toFixed(2)}×` : '—'} />
      </div>
      {note && <div style={{ fontSize: 10, color: subtle, marginTop: 3 }}>{note}</div>}
    </div>
  );
}

function PlatformStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 1 }}>{value}</div>
    </div>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Page indices to show, with -1 marking an ellipsis gap (first, last, ±2 around current).
function pageWindow(current: number, count: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < count; p++) {
    if (p === 0 || p === count - 1 || Math.abs(p - current) <= 2) out.push(p);
    else if (out[out.length - 1] !== -1) out.push(-1);
  }
  return out;
}

const pageBtn: CSSProperties = {
  fontSize: 12, padding: '4px 9px', border: '1px solid var(--color-border)',
  borderRadius: 6, background: 'var(--color-surface)', cursor: 'pointer',
};
const pageBtnActive: CSSProperties = {
  ...pageBtn, background: 'var(--color-crimson)', color: '#fff', borderColor: 'var(--color-crimson)',
};

const selectStyle: CSSProperties = {
  padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)',
};
const btnStyle: CSSProperties = {
  padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm, 6px)',
};
