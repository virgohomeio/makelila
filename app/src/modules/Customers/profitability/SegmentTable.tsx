import type { SegmentMetrics } from '../../../lib/profitability';
import styles from '../Customers.module.css';

/** One comparison table, reused for every segmentation the tab offers —
 *  channel, region, country, cohort, purchase volume. They all roll up to the
 *  same shape, so they all read the same way and can be compared side by side.
 *
 *  Sorted by lifetime profit unless the caller says otherwise; a segment that
 *  loses money is marked, not just coloured, so the signal survives print and
 *  colourblindness.
 */
export function SegmentTable({
  segments,
  dimensionLabel,
  onSelect,
  selected,
  emptyHint,
}: {
  segments: SegmentMetrics[];
  dimensionLabel: string;
  onSelect?: (key: string) => void;
  selected?: string | null;
  emptyHint?: string;
}) {
  if (segments.length === 0) {
    return <div className={styles.empty}>{emptyHint ?? 'Nothing matches these filters.'}</div>;
  }

  return (
    <div className={styles.segTableWrap}>
      <table className={styles.segTable}>
        <thead>
          <tr>
            <th>{dimensionLabel}</th>
            <th className={styles.num}>Customers</th>
            <th className={styles.num}>Units</th>
            <th className={styles.num}>Revenue</th>
            <th className={styles.num}>Variable costs</th>
            <th className={styles.num}>Contribution</th>
            <th className={styles.num}>CM %</th>
            <th className={styles.num}>CAC</th>
            <th className={styles.num}>LTV</th>
            <th className={styles.num}>LTV:CAC</th>
            <th className={styles.num}>Lifetime profit</th>
            <th className={styles.num}>Warranty</th>
            <th className={styles.num}>Service</th>
          </tr>
        </thead>
        <tbody>
          {segments.map(s => (
            <tr
              key={s.key}
              className={[
                s.lifetimeProfit < 0 ? styles.segLoss : '',
                selected === s.key ? styles.segSelected : '',
                onSelect ? styles.segClickable : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect?.(s.key)}
            >
              <td className={styles.segName}>
                {s.lifetimeProfit < 0 && <span className={styles.lossMark} aria-label="loss-making">▼</span>}
                {s.label}
              </td>
              <td className={styles.num}>{s.customers}</td>
              <td className={styles.num}>{s.units}</td>
              <td className={styles.num}>{money(s.revenue)}</td>
              <td className={styles.num}>{money(s.variableCosts)}</td>
              <td className={`${styles.num} ${s.contributionMargin < 0 ? styles.negative : ''}`}>
                {money(s.contributionMargin)}
              </td>
              <td className={styles.num}>{pct(s.contributionMarginPct)}</td>
              <td className={styles.num} title={s.cacUnpriced ? 'No traceable acquisition spend for this segment' : undefined}>
                {s.cacUnpriced ? <span className={styles.unpriced}>none on file</span> : money(s.cac)}
              </td>
              <td className={styles.num}>{money(s.ltv)}</td>
              <td className={styles.num}>{s.ltvCac == null ? '—' : `${s.ltvCac.toFixed(1)}×`}</td>
              <td className={`${styles.num} ${s.lifetimeProfit < 0 ? styles.negative : styles.positive}`}>
                {money(s.lifetimeProfit)}
              </td>
              <td className={styles.num}>{money(s.warrantyCost)}</td>
              <td className={styles.num}>{money(s.serviceCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function money(v: number | null): string {
  if (v == null) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString('en-CA')}`;
}

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}
