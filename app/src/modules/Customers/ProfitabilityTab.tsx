import { useMemo, useState } from 'react';
import { useCustomerProfitability, type CustomerProfitability } from '../../lib/customers';
import { formatMoney } from '../../lib/money';
import styles from './Customers.module.css';

type SortKey = 'margin_desc' | 'margin_asc' | 'warranty_desc' | 'revenue_desc';
type CountryFilter = 'all' | 'CA' | 'US' | 'other';

export function ProfitabilityTab() {
  const { rows, loading, error } = useCustomerProfitability();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('margin_desc');
  const [country, setCountry] = useState<CountryFilter>('all');
  // Backlog #58 V2 — onboard-date cohort filter. Lets operators isolate
  // a specific month's batch when a warranty spike correlates with a
  // hardware revision or shipping carrier change.
  const [cohort, setCohort] = useState<string>('all');
  // Default-hide team accounts (Pedrum etc.) so they don't skew the view.
  const [showTeam, setShowTeam] = useState(false);
  const [hideZero, setHideZero] = useState(true);

  const cohortOptions = useMemo(() => buildCohortOptions(rows), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(r => showTeam || !r.is_team_member)
      .filter(r => !hideZero || hasActivity(r))
      .filter(r => {
        if (country === 'all') return true;
        if (country === 'other') return r.country !== 'CA' && r.country !== 'US';
        return r.country === country;
      })
      .filter(r => cohort === 'all' || cohortOf(r) === cohort)
      .filter(r => q === '' || r.full_name.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q))
      .sort(sortFn(sort));
  }, [rows, search, sort, country, cohort, showTeam, hideZero]);

  const totals = useMemo(() => aggregate(filtered), [filtered]);
  // Insights are computed from the *unfiltered* set (minus team accounts)
  // so the panel always shows the full picture regardless of search.
  const insights = useMemo(() => computeInsights(rows.filter(r => showTeam || !r.is_team_member)), [rows, showTeam]);

  if (loading) return <div className={styles.loading}>Loading profitability…</div>;
  if (error) return <div className={styles.error}>Failed to load: {error.message}</div>;

  return (
    <div className={styles.profitabilityTab}>
      <div className={styles.profSummary}>
        <SummaryStat label="Customers"            value={String(filtered.length)} />
        <SummaryStat label="Revenue (net of tax)" value={fmt(totals.revenue)} />
        <SummaryStat label="Tax collected"        value={fmt(totals.tax)}       variant="warn" />
        <SummaryStat label="COGS + shipping"      value={fmt(totals.salesCost)} variant="warn" />
        <SummaryStat label="Expected warranty"    value={fmt(totals.warranty)}  variant="warn" />
        <SummaryStat label="Expected refunds"     value={fmt(totals.refund)}    variant="warn" />
        <SummaryStat label="Net margin"           value={fmt(totals.margin)}    variant={totals.margin < 0 ? 'bad' : 'good'} />
      </div>
      <div className={styles.profCurrencyNote}>
        Revenue excludes sales tax (passed through to govt, not VCycene income). "Expected warranty" sums COGS + shipping for every non-cancelled replacement order. "Expected refunds" sums every refund approval that isn't denied. Amounts shown in the order's native currency (CAD for most rows) — see #65 for the FX conversion follow-up.
      </div>

      <InsightsPanel insights={insights} />

      <div className={styles.profControls}>
        <input
          className={styles.profSearch}
          placeholder="Search customer…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)}>
          <option value="margin_desc">Most profitable</option>
          <option value="margin_asc">Losing money first</option>
          <option value="warranty_desc">Highest expected warranty</option>
          <option value="revenue_desc">Highest revenue</option>
        </select>
        <select value={country} onChange={e => setCountry(e.target.value as CountryFilter)}>
          <option value="all">All countries</option>
          <option value="CA">CA</option>
          <option value="US">US</option>
          <option value="other">Other</option>
        </select>
        <select value={cohort} onChange={e => setCohort(e.target.value)} title="Filter by onboard-date cohort">
          <option value="all">All cohorts</option>
          {cohortOptions.map(c => (
            <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
          ))}
        </select>
        <label className={styles.profToggle}>
          <input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} />
          <span>Hide zero-activity</span>
        </label>
        <label className={styles.profToggle}>
          <input type="checkbox" checked={showTeam} onChange={e => setShowTeam(e.target.checked)} />
          <span>Show team accounts</span>
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No customers match these filters.</div>
      ) : (
        <div className={styles.profGrid}>
          {filtered.map(r => <ProfitCard key={r.id} row={r} />)}
        </div>
      )}
    </div>
  );
}

function ProfitCard({ row }: { row: CustomerProfitability }) {
  const margin = row.net_margin_usd;
  const tone = margin < 0 ? styles.profCardLoss : margin === 0 ? styles.profCardFlat : styles.profCardWin;

  const refundLine = row.expected_refund_usd === row.settled_refund_usd
    ? fmt(row.expected_refund_usd)
    : `${fmt(row.expected_refund_usd)} (${fmt(row.settled_refund_usd)} settled)`;

  const warrantyLine = row.open_replacement_count === 0
    ? fmt(row.expected_warranty_cost_usd)
    : `${fmt(row.expected_warranty_cost_usd)} (${row.open_replacement_count} in-flight)`;

  return (
    <div className={`${styles.profCard} ${tone}`}>
      <div className={styles.profCardHead}>
        <div className={styles.profCardName}>
          {row.full_name}
          {row.is_team_member && <span className={styles.profTeamPill}>team</span>}
        </div>
        <div className={styles.profCardMeta}>
          {row.email ?? '—'}
          {row.country && <> · {row.country}</>}
        </div>
      </div>
      <div className={styles.profMargin}>{fmt(margin)}</div>
      <div className={styles.profCardLabel}>net margin</div>
      <dl className={styles.profCardBreakdown}>
        <div title="net of sales tax — tax is passed through to the govt, not VCycene revenue">
          <dt>Revenue</dt><dd>{fmt(row.revenue_usd)}</dd>
        </div>
        {row.tax_collected_usd > 0 && (
          <div title="sales tax collected for the govt (not in margin)">
            <dt>Tax</dt><dd className={styles.profTaxLine}>+{fmt(row.tax_collected_usd)}</dd>
          </div>
        )}
        <div><dt>COGS</dt><dd>{fmt(row.sale_cogs_usd)}</dd></div>
        <div><dt>Shipping</dt><dd>{fmt(row.sale_shipping_usd)}</dd></div>
        <div title="cogs + shipping on all non-cancelled replacement orders">
          <dt>Exp. warranty</dt><dd>{warrantyLine}</dd>
        </div>
        <div title="all refund approvals that haven't been denied">
          <dt>Exp. refunds</dt><dd>{refundLine}</dd>
        </div>
      </dl>
      <div className={styles.profCardCounts}>
        <span>{row.order_count} orders</span>
        <span>{row.replacement_count} replacements</span>
        <span>{row.refund_count} refunds</span>
        <span>{row.ticket_count} tickets</span>
        {row.open_warranty_ticket_count > 0 && (
          <span className={styles.profStatWarn} title="Open warranty/defect tickets with no replacement order yet — expected warranty will likely grow when these convert">
            ⚠ {row.open_warranty_ticket_count} open warranty
          </span>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, variant }: { label: string; value: string; variant?: 'good' | 'bad' | 'warn' }) {
  const cls = variant === 'good' ? styles.profStatGood
            : variant === 'bad'  ? styles.profStatBad
            : variant === 'warn' ? styles.profStatWarn
            : '';
  return (
    <div className={`${styles.profStat} ${cls}`}>
      <div className={styles.profStatLabel}>{label}</div>
      <div className={styles.profStatValue}>{value}</div>
    </div>
  );
}

function hasActivity(r: CustomerProfitability): boolean {
  return r.order_count > 0
      || r.replacement_count > 0
      || r.refund_count > 0
      || r.expected_warranty_cost_usd > 0
      || r.expected_refund_usd > 0
      || r.open_warranty_ticket_count > 0;
}

function sortFn(key: SortKey): (a: CustomerProfitability, b: CustomerProfitability) => number {
  switch (key) {
    case 'margin_desc':   return (a, b) => b.net_margin_usd - a.net_margin_usd;
    case 'margin_asc':    return (a, b) => a.net_margin_usd - b.net_margin_usd;
    case 'warranty_desc': return (a, b) => b.expected_warranty_cost_usd - a.expected_warranty_cost_usd;
    case 'revenue_desc':  return (a, b) => b.revenue_usd - a.revenue_usd;
  }
}

function aggregate(rs: CustomerProfitability[]) {
  return rs.reduce(
    (acc, r) => ({
      revenue:   acc.revenue   + r.revenue_usd,
      tax:       acc.tax       + r.tax_collected_usd,
      salesCost: acc.salesCost + r.sale_cogs_usd + r.sale_shipping_usd,
      warranty:  acc.warranty  + r.expected_warranty_cost_usd,
      refund:    acc.refund    + r.expected_refund_usd,
      margin:    acc.margin    + r.net_margin_usd,
    }),
    { revenue: 0, tax: 0, salesCost: 0, warranty: 0, refund: 0, margin: 0 },
  );
}

function fmt(n: number): string {
  return formatMoney(n, 'USD');
}

// ── Backlog #58 V2 — insights panel + cohort helpers ────────────────────────

function cohortOf(r: CustomerProfitability): string {
  if (!r.onboard_date) return 'unknown';
  return r.onboard_date.slice(0, 7);
}

function buildCohortOptions(rows: CustomerProfitability[]):
  { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = cohortOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      label: key === 'unknown' ? 'Unknown' : key,
      count,
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

type Insights = {
  byCountry: { country: string; n: number; avgMargin: number; avgWarranty: number }[];
  repeatWarranty: { n: number; avgMargin: number; baselineAvgMargin: number };
  cohortWarrantyTop: { cohort: string; n: number; warrantyRate: number; avgMargin: number }[];
};

function computeInsights(rows: CustomerProfitability[]): Insights {
  const active = rows.filter(hasActivity);

  const buckets = new Map<string, CustomerProfitability[]>();
  for (const r of active) {
    const k = r.country === 'CA' || r.country === 'US' ? r.country : 'Other';
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }
  const byCountry = ['CA', 'US', 'Other']
    .map(country => {
      const arr = buckets.get(country) ?? [];
      const n = arr.length;
      if (n === 0) return { country, n, avgMargin: 0, avgWarranty: 0 };
      const avgMargin   = arr.reduce((s, r) => s + r.net_margin_usd, 0) / n;
      const avgWarranty = arr.reduce((s, r) => s + r.expected_warranty_cost_usd, 0) / n;
      return { country, n, avgMargin, avgWarranty };
    })
    .filter(b => b.n > 0);

  const repeaters = active.filter(r => r.replacement_count >= 2);
  const baselineActive = active;
  const repeatWarranty = {
    n: repeaters.length,
    avgMargin: repeaters.length
      ? repeaters.reduce((s, r) => s + r.net_margin_usd, 0) / repeaters.length
      : 0,
    baselineAvgMargin: baselineActive.length
      ? baselineActive.reduce((s, r) => s + r.net_margin_usd, 0) / baselineActive.length
      : 0,
  };

  const cohortBuckets = new Map<string, CustomerProfitability[]>();
  for (const r of active) {
    const k = cohortOf(r);
    if (k === 'unknown') continue;
    const arr = cohortBuckets.get(k) ?? [];
    arr.push(r);
    cohortBuckets.set(k, arr);
  }
  const cohortWarrantyTop = Array.from(cohortBuckets.entries())
    .filter(([, arr]) => arr.length >= 3)
    .map(([cohort, arr]) => {
      const n = arr.length;
      const withWarranty = arr.filter(r => r.expected_warranty_cost_usd > 0).length;
      return {
        cohort,
        n,
        warrantyRate: withWarranty / n,
        avgMargin: arr.reduce((s, r) => s + r.net_margin_usd, 0) / n,
      };
    })
    .sort((a, b) => b.warrantyRate - a.warrantyRate)
    .slice(0, 5);

  return { byCountry, repeatWarranty, cohortWarrantyTop };
}

function InsightsPanel({ insights }: { insights: Insights }) {
  const { byCountry, repeatWarranty, cohortWarrantyTop } = insights;
  return (
    <div className={styles.profInsights}>
      <div className={styles.profInsightsHeader}>Insights</div>
      <div className={styles.profInsightsGrid}>
        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Avg margin by country</div>
          {byCountry.length === 0 ? (
            <div className={styles.profInsightEmpty}>No active customers.</div>
          ) : (
            <table className={styles.profInsightTable}>
              <thead><tr><th>Country</th><th>N</th><th>Avg margin</th><th>Avg exp. warranty</th></tr></thead>
              <tbody>
                {byCountry.map(b => (
                  <tr key={b.country}>
                    <td>{b.country}</td>
                    <td>{b.n}</td>
                    <td className={b.avgMargin < 0 ? styles.profStatBad : styles.profStatGood}>{fmt(b.avgMargin)}</td>
                    <td className={styles.profStatWarn}>{fmt(b.avgWarranty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Repeat-warranty customers (≥2 replacements)</div>
          {repeatWarranty.n === 0 ? (
            <div className={styles.profInsightEmpty}>None yet.</div>
          ) : (
            <div className={styles.profInsightStats}>
              <div><span className={styles.profInsightStatValue}>{repeatWarranty.n}</span><span className={styles.profInsightStatLabel}>customers</span></div>
              <div>
                <span className={`${styles.profInsightStatValue} ${repeatWarranty.avgMargin < 0 ? styles.profStatBad : styles.profStatGood}`}>
                  {fmt(repeatWarranty.avgMargin)}
                </span>
                <span className={styles.profInsightStatLabel}>avg margin</span>
              </div>
              <div>
                <span className={styles.profInsightStatValue}>{fmt(repeatWarranty.baselineAvgMargin)}</span>
                <span className={styles.profInsightStatLabel}>baseline (all active)</span>
              </div>
            </div>
          )}
        </div>

        <div className={styles.profInsightCard}>
          <div className={styles.profInsightTitle}>Worst cohorts by warranty rate</div>
          {cohortWarrantyTop.length === 0 ? (
            <div className={styles.profInsightEmpty}>Need ≥3 customers per cohort.</div>
          ) : (
            <table className={styles.profInsightTable}>
              <thead><tr><th>Cohort</th><th>N</th><th>Warranty %</th><th>Avg margin</th></tr></thead>
              <tbody>
                {cohortWarrantyTop.map(c => (
                  <tr key={c.cohort}>
                    <td>{c.cohort}</td>
                    <td>{c.n}</td>
                    <td className={styles.profStatWarn}>{(c.warrantyRate * 100).toFixed(0)}%</td>
                    <td className={c.avgMargin < 0 ? styles.profStatBad : ''}>{fmt(c.avgMargin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
