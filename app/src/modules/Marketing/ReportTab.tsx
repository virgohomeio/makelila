import { useMemo, useState, type CSSProperties } from 'react';
import { useOrders, type Order } from '../../lib/orders';
import { useFbCampaigns } from '../../lib/marketing/facebook';
import {
  buildSalesReport, salesRowsToCsv, useCustomerAttribution, type Attribution,
} from '../../lib/marketing/salesReport';

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
  const { campaigns } = useFbCampaigns(365);
  const [days, setDays] = useState(60);

  const cutoff = useMemo(() => (days ? Date.now() - days * 86_400_000 : 0), [days]);

  const inRange = (iso: string | null | undefined) => {
    if (!cutoff) return true;
    if (!iso) return false;
    return new Date(iso).getTime() >= cutoff;
  };

  const adSpendCad = useMemo(
    () => campaigns.filter(c => inRange(c.date_start)).reduce((s, c) => s + (c.spend_cad ?? 0), 0),
    [campaigns, cutoff], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const { rows, kpis } = useMemo(() => {
    const filtered = orders.filter(o => o.kind !== 'replacement' && inRange(o.placed_at ?? o.created_at));
    const resolve = (o: Order): Attribution =>
      (o.customer_id ? byId.get(o.customer_id) : undefined) ??
      (o.customer_email ? byEmail.get(o.customer_email.toLowerCase()) : undefined) ??
      { source: null, medium: null, campaign: null };
    return buildSalesReport(filtered, resolve, adSpendCad);
  }, [orders, byId, byEmail, adSpendCad, cutoff]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <select value={days} onChange={e => setDays(Number(e.target.value))} style={selectStyle}>
          {RANGES.map(r => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        <button onClick={downloadCsv} disabled={rows.length === 0} style={btnStyle}>↓ Download CSV</button>
        {kpis.adSpendCad === 0 && (
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
        Revenue sums order totals across currencies as-is; ad spend is CAD. Visit counts, exact ad creative, time-after-visit
        and age/gender aren't here — those need the Shopify Customer-Journey + Klaviyo event tracking.
      </div>

      {/* Per-buyer table */}
      {ordersLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 18 }}>
          <thead>
            <tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}>
              <th style={{ paddingBottom: 6 }}>Date</th><th>Name</th><th>Location</th>
              <th>Channel</th><th>Campaign</th><th>Plan</th><th>Codes</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.order_ref} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '6px 0', whiteSpace: 'nowrap' }}>{r.placed_at ? new Date(r.placed_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '—'}</td>
                <td>{r.name}</td>
                <td style={{ color: muted }}>{[r.city, r.region, r.country].filter(Boolean).join(', ')}</td>
                <td>{r.channel}</td>
                <td style={{ color: muted }}>{r.campaign ?? '—'}</td>
                <td>{r.plan}</td>
                <td style={{ color: muted }}>{r.discount_codes.join(' + ') || '—'}</td>
                <td style={{ textAlign: 'right' }}>{money(r.revenue)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} style={{ padding: 12, color: subtle }}>No sales in this window.</td></tr>}
          </tbody>
        </table>
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

const selectStyle: CSSProperties = {
  padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)',
};
const btnStyle: CSSProperties = {
  padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm, 6px)',
};
