import { useMemo, useState, type CSSProperties } from 'react';
import { useOrders, type Order } from '../../lib/orders';
import { useFbCampaigns, useFbDemographics } from '../../lib/marketing/facebook';
import {
  buildSalesReport, salesRowsToCsv, reportCells, REPORT_COLUMNS, UNKNOWN,
  useCustomerAttribution, type Attribution, type Demo,
} from '../../lib/marketing/salesReport';
import { useKlaviyoJourneys, summarizeJourney } from '../../lib/marketing/journeyTiming';
import { buildCampaignGroups } from '../../lib/marketing/campaignGroups';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

const RANGES = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 60 days', days: 60 },
  { label: 'Last 90 days', days: 90 },
  { label: 'All time', days: 0 },
];

export function ReportTab() {
  const { all: orders, loading: ordersLoading } = useOrders();
  const { byId, byEmail } = useCustomerAttribution();
  const { byCustomer: journeys } = useKlaviyoJourneys();
  const { campaigns } = useFbCampaigns(365);
  const { demographics } = useFbDemographics();
  const [days, setDays] = useState(60);
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);

  const cutoff = useMemo(() => (days ? Date.now() - days * 86_400_000 : 0), [days]);

  const inRange = (iso: string | null | undefined) => {
    if (!cutoff) return true;
    if (!iso) return false;
    return new Date(iso).getTime() >= cutoff;
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

  const adSpendCad = useMemo(() => {
    // Group spend (all its Meta campaigns) when a group is picked; else range total.
    if (selectedGroup) return campaigns.filter(c => c.campaign_id && selectedGroup.ids.has(c.campaign_id)).reduce((s, c) => s + (c.spend_cad ?? 0), 0);
    return campaigns.filter(c => inRange(c.date_start)).reduce((s, c) => s + (c.spend_cad ?? 0), 0);
  }, [campaigns, cutoff, selectedGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  const { rows, kpis } = useMemo(() => {
    const filtered = orders.filter(o => o.kind !== 'replacement' && inScope(o));
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
    const dayKey = (iso: string, country: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}|${country}`;
    };
    const demoByKey = new Map<string, Map<string, number>>();
    for (const d of demographics) {
      if (!d.purchases) continue;
      const k = `${d.date}|${d.country}`;
      const seg = `${d.age}|${d.gender}`;
      const m = demoByKey.get(k) ?? new Map<string, number>();
      m.set(seg, (m.get(seg) ?? 0) + (d.purchases ?? 0));
      demoByKey.set(k, m);
    }
    const salesByKey = new Map<string, number>();
    for (const o of orders) {
      if (o.kind === 'replacement') continue;
      const k = dayKey(o.placed_at ?? o.created_at, o.country);
      salesByKey.set(k, (salesByKey.get(k) ?? 0) + 1);
    }
    const demo = (o: Order): Demo => {
      const k = dayKey(o.placed_at ?? o.created_at, o.country);
      const segs = demoByKey.get(k);
      if (!segs) return { age: null, gender: null };
      const total = Array.from(segs.values()).reduce((a, b) => a + b, 0);
      const distinct = Array.from(segs.entries()).filter(([, v]) => v > 0);
      const sales = salesByKey.get(k) ?? 0;
      if (sales === 1 && total === 1 && distinct.length === 1) {
        const [age, gender] = distinct[0][0].split('|');
        return { age, gender };
      }
      return { age: null, gender: null };
    };

    // Which campaign bucket each sale piled into (shown in the Campaign column).
    const groupOf = (o: Order): string | null => {
      const d = estDate(o.placed_at ?? o.created_at);
      const g = campaignGroups.find(gr => d >= gr.startDate && (!gr.endDate || d <= gr.endDate));
      return g ? g.label : null;
    };

    return buildSalesReport(filtered, resolve, adSpendCad, journey, campaignName, demo, groupOf);
  }, [orders, byId, byEmail, journeys, campaigns, campaignGroups, demographics, adSpendCad, cutoff, campaignFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <select value={days} onChange={e => { setDays(Number(e.target.value)); setPage(0); }} style={selectStyle} disabled={campaignFilter !== 'all'}>
          {RANGES.map(r => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
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

      {/* KPI block */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <Kpi label="Total sales" value={String(kpis.sales)} />
        <Kpi label="Revenue" value={money(kpis.revenue)} />
        <Kpi label="Ad spend (CAD)" value={money(kpis.adSpendCad)} />
        <Kpi label="CAC" value={kpis.cac != null ? money(kpis.cac) : '—'} />
        <Kpi label="ROAS" value={kpis.roas != null ? `${kpis.roas.toFixed(2)}×` : '—'} />
        <Kpi label="ROI" value={kpis.roiPct != null ? `${kpis.roiPct}%` : '—'} />
        <Kpi label="Gross profit" value={money(kpis.grossProfit)} />
      </div>

      <div style={{ fontSize: 11, color: muted, marginBottom: 14 }}>
        One row per buyer, mirroring the manual Sale tracker. <strong>Purchase time</strong> + visit history are auto-filled
        from Klaviyo; <strong>Age / Gender</strong> are best-effort from Meta's purchase demographics — filled only when a
        sale is an unambiguous match (that day + country had one sale and Meta shows one purchase in one age/gender segment),
        otherwise UNKNOWN. Still manual: the exact <strong>ad creative</strong> (v21a…) in Notes. Run Sync All to populate.
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
