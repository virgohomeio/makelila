import type { Batch, UnitStatus } from '../../lib/stock';
import styles from './Stock.module.css';

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
  return (
    <div className={styles.batchGrid}>
      {batches.map(b => {
        const counts = countsByBatch.get(b.id);
        const ready = counts?.['ready'] ?? 0;
        const reserved = counts?.['reserved'] ?? 0;
        const shipped = counts?.['shipped'] ?? 0;
        const preShip =
          (counts?.['in-production'] ?? 0) +
          (counts?.['inbound'] ?? 0) +
          (counts?.['ca-test'] ?? 0);
        const other =
          (counts?.['team-test'] ?? 0) +
          (counts?.['scrap'] ?? 0) +
          (counts?.['lost'] ?? 0) +
          (counts?.['rework'] ?? 0);
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
            <div className={styles.batchBreakdown}>
              {preShip > 0 && <Pill label="Pre-ship" n={preShip} color="#6b46c1" bg="#faf5ff" />}
              {ready > 0    && <Pill label="Ready"    n={ready}    color="#276749" bg="#f0fff4" />}
              {reserved > 0 && <Pill label="Reserved" n={reserved} color="#c05621" bg="#fffaf0" />}
              {shipped > 0  && <Pill label="Shipped"  n={shipped}  color="#2b6cb0" bg="#ebf8ff" />}
              {other > 0    && <Pill label="Other"    n={other}    color="#744210" bg="#fff5f5" />}
            </div>
            {b.unit_cost_usd && (
              <div className={styles.batchCost}>
                ${b.unit_cost_usd.toLocaleString()}/unit · {b.incoterm}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Pill({ label, n, color, bg }: { label: string; n: number; color: string; bg: string }) {
  return (
    <span className={styles.batchPill} style={{ color, background: bg }}>
      {label} <strong>{n}</strong>
    </span>
  );
}
