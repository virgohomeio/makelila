import type { Batch, UnitStatus } from '../../lib/stock';
import styles from './Stock.module.css';

// Group the 10 statuses into 5 slices for the pie chart — enough to show
// health at a glance without being noisy. Colors roughly align with the
// status palette so the legend reads the same way across the app.
type Slice = { key: string; label: string; color: string; statuses: UnitStatus[] };
const SLICES: Slice[] = [
  { key: 'preship',   label: 'Pre-ship',  color: '#9f7aea', statuses: ['in-production','inbound','ca-test'] },
  { key: 'available', label: 'Available', color: '#48bb78', statuses: ['ready','reserved'] },
  { key: 'shipped',   label: 'Shipped',   color: '#4299e1', statuses: ['shipped'] },
  { key: 'team',      label: 'Team/Test', color: '#d69e2e', statuses: ['team-test','rework'] },
  { key: 'loss',      label: 'Loss',      color: '#e53e3e', statuses: ['scrap','lost'] },
];

function sliceTotals(counts: Record<UnitStatus, number> | undefined): { total: number; byKey: Record<string, number> } {
  const byKey: Record<string, number> = {};
  let total = 0;
  for (const s of SLICES) {
    let n = 0;
    if (counts) for (const st of s.statuses) n += counts[st] ?? 0;
    byKey[s.key] = n;
    total += n;
  }
  return { total, byKey };
}

/** Donut chart — 54px outer, 34px inner. Returns an SVG element. */
function PieChart({ byKey, total, size = 54 }: { byKey: Record<string, number>; total: number; size?: number }) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 1, innerR = size * 0.34;
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="#eee" />
        <circle cx={cx} cy={cy} r={innerR} fill="#fff" />
      </svg>
    );
  }
  // If a single slice is 100%, just draw full circle of that color.
  const nonZero = SLICES.filter(s => byKey[s.key] > 0);
  if (nonZero.length === 1) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill={nonZero[0].color} />
        <circle cx={cx} cy={cy} r={innerR} fill="#fff" />
      </svg>
    );
  }

  let angle = -Math.PI / 2; // start at 12 o'clock
  const paths: { d: string; color: string; key: string }[] = [];
  for (const s of SLICES) {
    const n = byKey[s.key];
    if (n === 0) continue;
    const sweep = (n / total) * Math.PI * 2;
    const end = angle + sweep;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const largeArc = sweep > Math.PI ? 1 : 0;
    paths.push({
      key: s.key,
      color: s.color,
      d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`,
    });
    angle = end;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {paths.map(p => <path key={p.key} d={p.d} fill={p.color} />)}
      <circle cx={cx} cy={cy} r={innerR} fill="#fff" />
    </svg>
  );
}

function StatsList({
  total, preship, available, shipped, loss,
}: {
  total: number;
  preship: number;   // in-production + inbound + ca-test
  available: number; // ready + reserved
  shipped: number;
  loss: number;      // scrap + lost
}) {
  // Sell-through: of the units that have actually arrived (i.e. excluding
  // pre-ship stock still in China / on the boat), what % have shipped to
  // customers. Signals how quickly we're burning down landed inventory.
  const arrived = total - preship;
  const sellThroughPct = arrived > 0 ? Math.round((shipped / arrived) * 100) : 0;
  // Loss rate over arrived units (scrap/lost only count once they're landed).
  const lossPct = arrived > 0 ? Math.round((loss / arrived) * 100) : 0;
  return (
    <div className={styles.statsCol}>
      <div className={styles.stat}><span>Total</span><strong>{total}</strong></div>
      <div className={styles.stat}><span>Ready</span><strong>{available}</strong></div>
      <div className={styles.stat}>
        <span>Shipped</span>
        <strong>{shipped}{arrived > 0 && <span className={styles.statPct}> · {sellThroughPct}%</span>}</strong>
      </div>
      <div className={styles.stat}>
        <span>Loss</span>
        <strong className={lossPct > 20 ? styles.statWarn : ''}>
          {loss}{arrived > 0 && <span className={styles.statPct}> · {lossPct}%</span>}
        </strong>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className={styles.pieLegend}>
      {SLICES.map(s => (
        <span key={s.key} className={styles.pieLegendItem}>
          <span className={styles.pieSwatch} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// Cards
// ============================================================================

export function BatchCards({
  batches,
  countsByBatch,
  activeBatch,
  onSelect,
}: {
  batches: Batch[];
  countsByBatch: Map<string, Record<UnitStatus, number>>;
  activeBatch: string | null;
  onSelect: (id: string) => void;
}) {
  // Aggregate across every batch for the "All LILA Pros" card.
  const allCounts = aggregateAll(countsByBatch);
  const all = sliceTotals(allCounts);

  return (
    <div>
      <div className={styles.batchGrid}>
        <AllCard
          batches={batches}
          slices={all}
          showAllActive={activeBatch === null}
          clearFilter={() => {
            // Clicking "All" clears any active per-batch filter. If no filter
            // is set, this is a no-op.
            if (activeBatch !== null) onSelect(activeBatch);
          }}
        />
        {batches.map(b => {
          const counts = countsByBatch.get(b.id);
          const { total, byKey } = sliceTotals(counts);
          const isActive = activeBatch === b.id;
          const arrivedLabel = b.arrived_at
            ? new Date(b.arrived_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
            : 'In production';

          return (
            <button
              key={b.id}
              onClick={() => onSelect(b.id)}
              className={`${styles.batchCard} ${isActive ? styles.batchCardActive : ''}`}
            >
              <div className={styles.batchHead}>
                <span className={styles.batchName}>{b.id}</span>
                {b.version && <span className={styles.batchVersion}>{b.version}</span>}
                <span className={styles.batchMfg}>{b.manufacturer_short ?? b.manufacturer}</span>
              </div>
              <div className={styles.batchDate}>{arrivedLabel}</div>

              <div className={styles.batchBody}>
                <PieChart byKey={byKey} total={total} size={60} />
                <StatsList
                  total={total}
                  preship={byKey.preship}
                  available={byKey.available}
                  shipped={byKey.shipped}
                  loss={byKey.loss}
                />
              </div>

              {b.unit_cost_usd !== null && (
                <div className={styles.batchCost}>
                  ${b.unit_cost_usd.toLocaleString()}/unit · {b.incoterm}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <Legend />
    </div>
  );
}

function AllCard({
  batches,
  slices,
  showAllActive,
  clearFilter,
}: {
  batches: Batch[];
  slices: ReturnType<typeof sliceTotals>;
  showAllActive: boolean;
  clearFilter: () => void;
}) {
  const { total, byKey } = slices;
  // Extra stats specific to the "All" card: total inventory $, arrived batches,
  // and latest arrival so the CTO can see how fresh supply is at a glance.
  const arrivedBatches = batches.filter(b => b.arrived_at !== null);
  const totalInvested = batches.reduce((sum, b) => sum + (b.total_cost_usd ?? 0), 0);
  const latestArrival = arrivedBatches
    .map(b => b.arrived_at as string)
    .sort()
    .pop();

  return (
    <button
      onClick={clearFilter}
      className={`${styles.batchCard} ${styles.batchCardAll} ${showAllActive ? styles.batchCardActive : ''}`}
    >
      <div className={styles.batchHead}>
        <span className={styles.batchName}>All LILA Pros</span>
        <span className={styles.batchMfg}>{batches.length} batches</span>
      </div>
      <div className={styles.batchDate}>
        {latestArrival ? `Latest arrival ${new Date(latestArrival).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}` : '—'}
      </div>
      <div className={styles.batchBody}>
        <PieChart byKey={byKey} total={total} size={72} />
        <StatsList
          total={total}
          preship={byKey.preship}
          available={byKey.available}
          shipped={byKey.shipped}
          loss={byKey.loss}
        />
      </div>
      <div className={styles.batchCost}>
        ${totalInvested.toLocaleString()} total invested
      </div>
    </button>
  );
}

function aggregateAll(countsByBatch: Map<string, Record<UnitStatus, number>>): Record<UnitStatus, number> {
  const out: Record<UnitStatus, number> = {
    'in-production':0,'inbound':0,'ca-test':0,
    'ready':0,'reserved':0,'rework':0,
    'shipped':0,'team-test':0,'scrap':0,'lost':0,
  };
  for (const counts of countsByBatch.values()) {
    for (const k of Object.keys(counts) as UnitStatus[]) out[k] += counts[k];
  }
  return out;
}
