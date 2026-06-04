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
  // Default-hide team accounts (Pedrum etc.) so they don't skew the view.
  const [showTeam, setShowTeam] = useState(false);
  const [hideZero, setHideZero] = useState(true);

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
      .filter(r => q === '' || r.full_name.toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q))
      .sort(sortFn(sort));
  }, [rows, search, sort, country, showTeam, hideZero]);

  const totals = useMemo(() => aggregate(filtered), [filtered]);

  if (loading) return <div className={styles.loading}>Loading profitability…</div>;
  if (error) return <div className={styles.error}>Failed to load: {error.message}</div>;

  return (
    <div className={styles.profitabilityTab}>
      <div className={styles.profSummary}>
        <SummaryStat label="Customers" value={String(filtered.length)} />
        <SummaryStat label="Total revenue"  value={fmt(totals.revenue)} />
        <SummaryStat label="Total warranty" value={fmt(totals.warranty)} variant="warn" />
        <SummaryStat label="Total refunds"  value={fmt(totals.refund)}   variant="warn" />
        <SummaryStat label="Net margin"     value={fmt(totals.margin)}   variant={totals.margin < 0 ? 'bad' : 'good'} />
      </div>

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
          <option value="warranty_desc">Highest warranty cost</option>
          <option value="revenue_desc">Highest revenue</option>
        </select>
        <select value={country} onChange={e => setCountry(e.target.value as CountryFilter)}>
          <option value="all">All countries</option>
          <option value="CA">CA</option>
          <option value="US">US</option>
          <option value="other">Other</option>
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
        <div><dt>Revenue</dt><dd>{fmt(row.revenue_usd)}</dd></div>
        <div><dt>COGS</dt><dd>{fmt(row.cogs_usd)}</dd></div>
        <div><dt>Shipping</dt><dd>{fmt(row.shipping_cost_usd)}</dd></div>
        <div><dt>Warranty</dt><dd>{fmt(row.warranty_cost_usd)}</dd></div>
        <div><dt>Refunds</dt><dd>{fmt(row.refund_usd)}</dd></div>
      </dl>
      <div className={styles.profCardCounts}>
        <span>{row.order_count} orders</span>
        <span>{row.replacement_count} replacements</span>
        <span>{row.refund_count} refunds</span>
        <span>{row.ticket_count} tickets</span>
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
  return r.order_count > 0 || r.replacement_count > 0 || r.refund_count > 0 || r.warranty_cost_usd > 0;
}

function sortFn(key: SortKey): (a: CustomerProfitability, b: CustomerProfitability) => number {
  switch (key) {
    case 'margin_desc':   return (a, b) => b.net_margin_usd - a.net_margin_usd;
    case 'margin_asc':    return (a, b) => a.net_margin_usd - b.net_margin_usd;
    case 'warranty_desc': return (a, b) => b.warranty_cost_usd - a.warranty_cost_usd;
    case 'revenue_desc':  return (a, b) => b.revenue_usd - a.revenue_usd;
  }
}

function aggregate(rs: CustomerProfitability[]) {
  return rs.reduce(
    (acc, r) => ({
      revenue:  acc.revenue + r.revenue_usd,
      warranty: acc.warranty + r.warranty_cost_usd,
      refund:   acc.refund + r.refund_usd,
      margin:   acc.margin + r.net_margin_usd,
    }),
    { revenue: 0, warranty: 0, refund: 0, margin: 0 },
  );
}

function fmt(n: number): string {
  // Treat everything as USD-denominated for the summary numbers. The
  // underlying `*_usd` fields actually hold the order's `currency` (CAD
  // for most rows), but mixing currencies in a roll-up is a bigger
  // problem (#65 follow-up); for now we surface the numbers as-is.
  return formatMoney(n, 'USD');
}
