import { useMemo } from 'react';
import {
  useSalesOrders,
  useFinanceConfig,
  getProductFamily,
  projectRevenue,
  PRODUCT_FAMILIES,
  type SeasonalityConfig,
  type ProductFamily,
} from '../../lib/finance';
import styles from './Finance.module.css';

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
}

function fmtRange(lower: number, upper: number): string {
  return `${fmt(lower)} – ${fmt(upper)}`;
}

function getQuarterBounds(today: Date): { start: Date; end: Date } {
  const month = today.getUTCMonth(); // 0-indexed
  const quarterIndex = Math.floor(month / 3);
  const year = today.getUTCFullYear();
  const start = new Date(Date.UTC(year, quarterIndex * 3, 1));
  const end = new Date(Date.UTC(year, quarterIndex * 3 + 3, 0)); // last day of quarter
  return { start, end };
}

// ── Weekly bar chart (SVG) ────────────────────────────────────────────────────

interface WeeklyChartProps {
  historicalWeeks: number[];   // last 13 weeks, index 0 = oldest
  projectedWeeks: number[];    // next 13 weeks
}

function WeeklyChart({ historicalWeeks, projectedWeeks }: WeeklyChartProps) {
  const VIEW_W = 560;
  const VIEW_H = 120;
  const PAD_LEFT = 4;
  const PAD_RIGHT = 4;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 20;
  const CHART_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const CHART_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const TOTAL_BARS = historicalWeeks.length + projectedWeeks.length;
  const BAR_GAP = 2;
  const BAR_W = Math.max(2, (CHART_W - BAR_GAP * (TOTAL_BARS - 1)) / TOTAL_BARS);

  const allValues = [...historicalWeeks, ...projectedWeeks];
  const maxVal = Math.max(...allValues, 1);

  const dividerX = PAD_LEFT + historicalWeeks.length * (BAR_W + BAR_GAP) - BAR_GAP / 2;

  const barX = (i: number) => PAD_LEFT + i * (BAR_W + BAR_GAP);
  const barH = (val: number) => (val / maxVal) * CHART_H;
  const barY = (val: number) => PAD_TOP + CHART_H - barH(val);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width="100%"
      aria-label="Weekly revenue chart"
    >
      {/* Historical bars */}
      {historicalWeeks.map((val, i) => (
        <rect
          key={`h${i}`}
          x={barX(i)}
          y={barY(val)}
          width={BAR_W}
          height={barH(val)}
          fill="var(--color-crimson)"
          opacity="0.7"
        />
      ))}

      {/* Projected bars */}
      {projectedWeeks.map((val, i) => {
        const idx = historicalWeeks.length + i;
        return (
          <rect
            key={`p${i}`}
            x={barX(idx)}
            y={barY(val)}
            width={BAR_W}
            height={barH(val)}
            fill="var(--color-crimson)"
            opacity="0.25"
          />
        );
      })}

      {/* Divider line */}
      <line
        x1={dividerX}
        y1={PAD_TOP}
        x2={dividerX}
        y2={PAD_TOP + CHART_H}
        stroke="var(--color-ink-subtle)"
        strokeWidth="1"
        strokeDasharray="3 3"
      />

      {/* X-axis labels for historical weeks */}
      {historicalWeeks.map((_, i) => {
        if (i % 4 !== 0) return null;
        const label = `W${i + 1}`;
        return (
          <text
            key={`lh${i}`}
            x={barX(i) + BAR_W / 2}
            y={VIEW_H - 4}
            textAnchor="middle"
            fontSize="8"
            fill="var(--color-ink-subtle)"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SalesProjectionPanel() {
  const ninetyDaysAgo = useMemo(() => {
    const d = new Date(Date.now() - 90 * 24 * 3600_000);
    return d.toISOString();
  }, []);

  const { orders, loading: ordersLoading, error: ordersError } = useSalesOrders(ninetyDaysAgo);
  const { value: seasonalityRaw, loading: seasonLoading } = useFinanceConfig('seasonality');
  const { value: okrRaw, loading: okrLoading } = useFinanceConfig('revenue_okr_quarterly_cad');

  const loading = ordersLoading || seasonLoading || okrLoading;

  const seasonality: SeasonalityConfig = useMemo(() => {
    if (!seasonalityRaw || typeof seasonalityRaw !== 'object') {
      return Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), 1.0]));
    }
    return seasonalityRaw as SeasonalityConfig;
  }, [seasonalityRaw]);

  const okrAmount: number = useMemo(() => {
    if (!okrRaw || typeof okrRaw !== 'object') return 0;
    const rec = okrRaw as Record<string, unknown>;
    return typeof rec.amount === 'number' ? rec.amount : 0;
  }, [okrRaw]);

  // ── Per-family projections (CAD) ──────────────────────────────────────────

  type FamilyStats = {
    family: ProductFamily;
    weeklyVelocity: number;
    aov: number;
    proj30: number; lower30: number; upper30: number;
    proj60: number; lower60: number; upper60: number;
    proj90: number; lower90: number; upper90: number;
  };

  const cadStats: FamilyStats[] = useMemo(() => {
    const allFamilies: ProductFamily[] = [...PRODUCT_FAMILIES, 'other'];
    return allFamilies.map(family => {
      const relevant = orders.filter(o => {
        if (o.currency !== 'CAD') return false;
        const li = Array.isArray(o.line_items) ? o.line_items : [];
        return getProductFamily(li) === family;
      });
      const weeklyVelocity = relevant.length / (90 / 7);
      const revenues = relevant.map(o => o.total_usd);
      const aov = revenues.length > 0 ? revenues.reduce((a, b) => a + b, 0) / revenues.length : 0;

      const r30 = projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 30 });
      const r60 = projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 60 });
      const r90 = projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 90 });

      return {
        family,
        weeklyVelocity,
        aov,
        proj30: r30.projected, lower30: r30.lower, upper30: r30.upper,
        proj60: r60.projected, lower60: r60.lower, upper60: r60.upper,
        proj90: r90.projected, lower90: r90.lower, upper90: r90.upper,
      };
    });
  }, [orders, seasonality]);

  // ── USD stats (separate section) ─────────────────────────────────────────

  const usdStats = useMemo(() => {
    const usdOrders = orders.filter(o => o.currency === 'USD');
    const weeklyVelocity = usdOrders.length / (90 / 7);
    const revs = usdOrders.map(o => o.total_usd);
    const aov = revs.length > 0 ? revs.reduce((a, b) => a + b, 0) / revs.length : 0;
    return {
      orders: usdOrders,
      weeklyVelocity,
      aov,
      r30: projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 30 }),
      r60: projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 60 }),
      r90: projectRevenue({ weeklyVelocity, aov, seasonality, horizon: 90 }),
    };
  }, [orders, seasonality]);

  // ── Overall CAD KPI tiles ─────────────────────────────────────────────────

  const cadTotals = useMemo(() => ({
    r30:     cadStats.reduce((sum, s) => sum + s.proj30,  0),
    lower30: cadStats.reduce((sum, s) => sum + s.lower30, 0),
    upper30: cadStats.reduce((sum, s) => sum + s.upper30, 0),
    r60:     cadStats.reduce((sum, s) => sum + s.proj60,  0),
    lower60: cadStats.reduce((sum, s) => sum + s.lower60, 0),
    upper60: cadStats.reduce((sum, s) => sum + s.upper60, 0),
    r90:     cadStats.reduce((sum, s) => sum + s.proj90,  0),
    lower90: cadStats.reduce((sum, s) => sum + s.lower90, 0),
    upper90: cadStats.reduce((sum, s) => sum + s.upper90, 0),
  }), [cadStats]);

  // ── OKR pace banner ───────────────────────────────────────────────────────

  const okrBanner = useMemo(() => {
    if (okrAmount <= 0) return null;
    const today = new Date();
    const { start: qStart, end: qEnd } = getQuarterBounds(today);
    const daysElapsed = Math.max(1, Math.round((today.getTime() - qStart.getTime()) / (24 * 3600_000)));
    const daysInQuarter = Math.round((qEnd.getTime() - qStart.getTime()) / (24 * 3600_000)) + 1;
    const expectedByNow = (okrAmount / daysInQuarter) * daysElapsed;

    const qStartIso = qStart.toISOString();
    const actualQRevenue = orders
      .filter(o => o.currency === 'CAD' && o.placed_at != null && o.placed_at >= qStartIso)
      .reduce((sum, o) => sum + o.total_usd, 0);

    if (actualQRevenue >= expectedByNow * 0.9) return null;

    const pct = okrAmount > 0 ? Math.round(((expectedByNow - actualQRevenue) / okrAmount) * 100) : 0;
    const daysRemaining = Math.max(1, daysInQuarter - daysElapsed);
    const shortfall = okrAmount - actualQRevenue;
    const dailyNeeded = shortfall / daysRemaining;

    return { pct, okrAmount, dailyNeeded };
  }, [okrAmount, orders]);

  // ── Weekly bar chart data ─────────────────────────────────────────────────

  const { historicalWeeks, projectedWeeks } = useMemo(() => {
    // Build 13 historical weekly buckets (week 0 = oldest, week 12 = most recent)
    const hist: number[] = Array(13).fill(0);
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 3600_000;

    for (const o of orders) {
      if (o.currency !== 'CAD' || !o.placed_at) continue;
      const ageMs = now - Date.parse(o.placed_at);
      const weeksAgo = Math.floor(ageMs / WEEK_MS);
      if (weeksAgo < 13) {
        hist[12 - weeksAgo] += o.total_usd;
      }
    }

    // 13 projected weekly buckets: use overall CAD weekly velocity * aov
    const cadOrders = orders.filter(o => o.currency === 'CAD');
    const wv = cadOrders.length / (90 / 7);
    const cadRevs = cadOrders.map(o => o.total_usd);
    const av = cadRevs.length > 0 ? cadRevs.reduce((a, b) => a + b, 0) / cadRevs.length : 0;
    const weeklyProjected = wv * av;
    const proj: number[] = Array(13).fill(weeklyProjected);

    return { historicalWeeks: hist, projectedWeeks: proj };
  }, [orders]);

  // ── render ────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className={styles.loading}>Loading sales projections…</div>;
  }

  if (ordersError) {
    return <div className={styles.empty}>Error loading orders: {ordersError}</div>;
  }

  const tableRows = cadStats.filter(s => s.family !== 'other' || s.proj30 > 0);

  return (
    <div className={styles.projectionPanel}>
      <p className={styles.projectionTitle}>Sales Projections</p>
      <p className={styles.projectionSubtitle}>
        Rolling-average model · 90-day trailing window · CAD
      </p>

      {okrBanner && (
        <div className={styles.okrBanner}>
          On-pace warning: projected Q revenue is {okrBanner.pct}% below OKR target
          of {fmt(okrBanner.okrAmount)}. Needed daily: {fmt(okrBanner.dailyNeeded)}.
        </div>
      )}

      {/* KPI tiles */}
      <div className={styles.kpiRow}>
        <div className={styles.kpiTile}>
          <div className={styles.kpiLabel}>30-day CAD</div>
          <div className={styles.kpiValue}>{fmt(cadTotals.r30)}</div>
          <div className={styles.kpiRange}>{fmtRange(cadTotals.lower30, cadTotals.upper30)}</div>
        </div>
        <div className={styles.kpiTile}>
          <div className={styles.kpiLabel}>60-day CAD</div>
          <div className={styles.kpiValue}>{fmt(cadTotals.r60)}</div>
          <div className={styles.kpiRange}>{fmtRange(cadTotals.lower60, cadTotals.upper60)}</div>
        </div>
        <div className={styles.kpiTile}>
          <div className={styles.kpiLabel}>90-day CAD</div>
          <div className={styles.kpiValue}>{fmt(cadTotals.r90)}</div>
          <div className={styles.kpiRange}>{fmtRange(cadTotals.lower90, cadTotals.upper90)}</div>
        </div>
      </div>

      {/* Weekly bar chart */}
      <div className={styles.chartWrap}>
        <div className={styles.chartLegend}>
          <span>
            <span className={styles.legendDotHistorical} />
            Historical (13 weeks)
          </span>
          <span>
            <span className={styles.legendDotProjected} />
            Projected (13 weeks)
          </span>
        </div>
        <WeeklyChart historicalWeeks={historicalWeeks} projectedWeeks={projectedWeeks} />
      </div>

      {/* Breakdown table — CAD */}
      <p className={styles.sectionLabel}>By Product · CAD</p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Product</th>
              <th>Weekly Velocity</th>
              <th>AOV (CAD)</th>
              <th>30d Projected</th>
              <th>60d Projected</th>
              <th>90d Projected</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map(s => (
              <tr key={s.family} className={styles.row}>
                <td>{s.family}</td>
                <td>{s.weeklyVelocity.toFixed(1)}/wk</td>
                <td>{fmt(s.aov)}</td>
                <td>{fmt(s.proj30)}</td>
                <td>{fmt(s.proj60)}</td>
                <td>{fmt(s.proj90)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* USD section — only shown if there are USD orders */}
      {usdStats.orders.length > 0 && (
        <>
          <p className={styles.sectionLabelSpaced}>Overall · USD</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Weekly Velocity</th>
                  <th>AOV (USD)</th>
                  <th>30d Projected</th>
                  <th>60d Projected</th>
                  <th>90d Projected</th>
                </tr>
              </thead>
              <tbody>
                <tr className={styles.row}>
                  <td>USD</td>
                  <td>{usdStats.weeklyVelocity.toFixed(1)}/wk</td>
                  <td>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(usdStats.aov)}
                  </td>
                  <td>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(usdStats.r30.projected)}
                  </td>
                  <td>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(usdStats.r60.projected)}
                  </td>
                  <td>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(usdStats.r90.projected)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className={styles.confidenceNote}>
        Projections use a ±15% illustrative confidence band, not a statistical prediction interval.
      </p>
    </div>
  );
}
