import { useMemo } from 'react';
import {
  useReturns, useRefundApprovals,
  RETURN_CATEGORIES, RETURN_CATEGORY_META, returnTeamCounts,
  type ReturnRow, type RefundApproval,
} from '../../lib/postShipment';
import styles from './PostShipment.module.css';

const THIS_YEAR = new Date().getFullYear();
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TEAM_COLORS = ['#9b2c2c', '#2b6cb0', '#c05621', '#553c9a', '#276749', '#718096'];

type Aggregates = {
  totalYTD: number;
  refundedYTD: number;
  avgDaysToRefund: number | null;
  denialRate: number;
  byCategory: Array<{ label: string; value: number; color: string }>;
  byTeam: Array<{ label: string; value: number }>;
  byChannel: Array<{ label: string; value: number }>;
  byCondition: Array<{ label: string; value: number }>;
  byMonth: Array<{ label: string; value: number }>;
};

function computeStats(returns: ReturnRow[], approvals: RefundApproval[]): Aggregates {
  const yr = (iso: string | null) => iso ? new Date(iso).getFullYear() : -1;
  const returnsYTD = returns.filter(r => yr(r.created_at) === THIS_YEAR);

  // KPI 1: total returns YTD
  const totalYTD = returnsYTD.length;

  // KPI 2: refunded $ YTD
  const refundedYTD = approvals
    .filter(a => a.status === 'refunded' && yr(a.finance_approved_at) === THIS_YEAR)
    .reduce((s, a) => s + Number(a.refund_amount_usd ?? 0), 0);

  // KPI 3: avg days from submission → finance_approved (refunded only)
  const refundedRows = approvals.filter(a => a.status === 'refunded' && a.finance_approved_at && a.submitted_at);
  const avgDaysToRefund = refundedRows.length === 0 ? null : Math.round(
    refundedRows.reduce((s, a) => {
      const ms = new Date(a.finance_approved_at!).getTime() - new Date(a.submitted_at).getTime();
      return s + ms / 86_400_000;
    }, 0) / refundedRows.length
  );

  // KPI 4: denial rate (of denied + refunded, denied share)
  const refundedCount = approvals.filter(a => a.status === 'refunded').length;
  const deniedCount = approvals.filter(a => a.status === 'denied').length;
  const denom = refundedCount + deniedCount;
  const denialRate = denom === 0 ? 0 : deniedCount / denom;

  // Chart 1: by category
  const byCategory = RETURN_CATEGORIES.map(c => ({
    label: RETURN_CATEGORY_META[c].label.split(' ')[0],  // short label for axis
    value: returnsYTD.filter(r => r.return_category === c).length,
    color: RETURN_CATEGORY_META[c].color,
  }));

  // Chart 2: by channel
  const channelCounts: Record<string, number> = { Canada: 0, USA: 0, Unknown: 0 };
  for (const r of returnsYTD) {
    const k = r.channel ?? 'Unknown';
    channelCounts[k] = (channelCounts[k] ?? 0) + 1;
  }
  const byChannel = Object.entries(channelCounts)
    .filter(([, v]) => v > 0)
    .map(([label, value]) => ({ label, value }));

  // Chart 3: by condition
  const conditionOrder = ['like-new', 'good', 'fair', 'used', 'unused', 'damaged'];
  const conditionCounts: Record<string, number> = {};
  for (const r of returnsYTD) {
    const k = r.condition ?? 'Unknown';
    conditionCounts[k] = (conditionCounts[k] ?? 0) + 1;
  }
  const byCondition = conditionOrder
    .filter(c => conditionCounts[c] > 0)
    .map(c => ({ label: c, value: conditionCounts[c] }));

  // Chart 4: monthly trend YTD
  const monthCounts = new Array(12).fill(0);
  for (const r of returnsYTD) {
    const m = new Date(r.created_at).getMonth();
    monthCounts[m]++;
  }
  const currentMonth = new Date().getMonth();
  const byMonth = MONTH_LABELS.slice(0, currentMonth + 1).map((label, i) => ({ label, value: monthCounts[i] }));

  // Chart 5: responsible team (derived from category)
  const byTeam = returnTeamCounts(returnsYTD);

  return { totalYTD, refundedYTD, avgDaysToRefund, denialRate, byCategory, byTeam, byChannel, byCondition, byMonth };
}

// ─── Charts (inline SVG; no chart-lib dep) ─────────────────────────────────

function BarChart({ data }: { data: Array<{ label: string; value: number; color?: string }> }) {
  if (data.length === 0) return <div className={styles.chartEmpty}>No data yet</div>;
  const max = Math.max(...data.map(d => d.value), 1);
  const w = 320, h = 180, pad = 28;
  const barW = (w - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={styles.chartSvg}>
      {data.map((d, i) => {
        const barH = ((h - pad * 2) * d.value) / max;
        const x = pad + i * barW + 4;
        const y = h - pad - barH;
        const color = d.color ?? '#553c9a';
        return (
          <g key={`${d.label}-${i}`}>
            <rect x={x} y={y} width={barW - 8} height={barH} fill={color} />
            {d.value > 0 && (
              <text x={x + (barW - 8) / 2} y={y - 4} textAnchor="middle" fontSize="10" fill="#444">{d.value}</text>
            )}
            <text x={x + (barW - 8) / 2} y={h - 8} textAnchor="middle" fontSize="9" fill="#666">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function DonutChart({ data, colors }: { data: Array<{ label: string; value: number }>; colors: string[] }) {
  if (data.length === 0) return <div className={styles.chartEmpty}>No data yet</div>;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 90, cy = 90, r = 70, rInner = 45;
  const segments: { d: string; color: string; label: string; value: number; mid: number }[] = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const sweep = (d.value / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(angle), y0 = cy + r * Math.sin(angle);
    const x1 = cx + r * Math.cos(angle + sweep), y1 = cy + r * Math.sin(angle + sweep);
    const xi0 = cx + rInner * Math.cos(angle + sweep), yi0 = cy + rInner * Math.sin(angle + sweep);
    const xi1 = cx + rInner * Math.cos(angle), yi1 = cy + rInner * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const pathD = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi0} ${yi0} A ${rInner} ${rInner} 0 ${large} 0 ${xi1} ${yi1} Z`;
    segments.push({ d: pathD, color: colors[i % colors.length], label: d.label, value: d.value, mid: angle + sweep / 2 });
    angle += sweep;
  }
  return (
    <div className={styles.donutWrap}>
      <svg viewBox="0 0 180 180" className={styles.chartSvg} style={{ width: 180 }}>
        {segments.map((s, i) => <path key={i} d={s.d} fill={s.color} />)}
      </svg>
      <div className={styles.donutLegend}>
        {segments.map((s, i) => (
          <div key={i} className={styles.donutLegendRow}>
            <span className={styles.donutSwatch} style={{ background: s.color }} />
            <span>{s.label}: <strong>{s.value}</strong></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChart({ data, color }: { data: Array<{ label: string; value: number }>; color: string }) {
  if (data.length === 0) return <div className={styles.chartEmpty}>No data yet</div>;
  const max = Math.max(...data.map(d => d.value), 1);
  const w = 360, h = 180, pad = 28;
  const stepX = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((h - pad * 2) * d.value) / max;
    return { x, y, label: d.label, value: d.value };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={styles.chartSvg}>
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3" fill={color} />
          {p.value > 0 && (
            <text x={p.x} y={p.y - 8} textAnchor="middle" fontSize="9" fill="#444">{p.value}</text>
          )}
          <text x={p.x} y={h - 8} textAnchor="middle" fontSize="9" fill="#666">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ─── Tab ──────────────────────────────────────────────────────────────────

export function DashboardTab() {
  const { returns, loading: rLoading } = useReturns();
  const { approvals, loading: aLoading } = useRefundApprovals();
  const stats = useMemo(() => computeStats(returns, approvals), [returns, approvals]);

  if (rLoading || aLoading) return <div className={styles.loading}>Loading dashboard…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label={`Returns ${THIS_YEAR}`} value={stats.totalYTD} />
        <KPI label={`Refunded $ ${THIS_YEAR}`} value={`$${stats.refundedYTD.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
        <KPI label="Avg days to refund" value={stats.avgDaysToRefund != null ? `${stats.avgDaysToRefund}d` : '—'} />
        <KPI label="Denial rate" value={`${(stats.denialRate * 100).toFixed(0)}%`} />
      </div>
      <div className={styles.dashGrid}>
        <ChartCard title="By Category"><BarChart data={stats.byCategory} /></ChartCard>
        <ChartCard title="By Channel"><DonutChart data={stats.byChannel} colors={['#2b6cb0', '#c53030', '#718096']} /></ChartCard>
        <ChartCard title="By Condition"><BarChart data={stats.byCondition} /></ChartCard>
        <ChartCard title="Responsible Team"><DonutChart data={stats.byTeam} colors={TEAM_COLORS} /></ChartCard>
        <ChartCard title={`Monthly Trend ${THIS_YEAR}`}><LineChart data={stats.byMonth} color="#276749" /></ChartCard>
      </div>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.chartCard}>
      <div className={styles.chartCardHead}>{title}</div>
      <div className={styles.chartCardBody}>{children}</div>
    </div>
  );
}
