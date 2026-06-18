import { useMemo, useState } from 'react';
import { STATUS_FILTERS, type FollowUpStatusKey, type DirectoryRow } from '../../lib/followupStatus';
import { FU_STATE_META } from '../../lib/customers';
import styles from './FollowUps.module.css';

export function FollowUpDirectory({
  rows, counts, overdueCount, onSelect,
}: {
  rows: DirectoryRow[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  onSelect: (customerId: string) => void;
}) {
  const [active, setActive] = useState<Set<FollowUpStatusKey>>(new Set());
  const toggle = (k: FollowUpStatusKey) =>
    setActive(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const filtered = useMemo(() => {
    if (active.size === 0) return rows;
    return rows.filter(r => [...active].some(k => r.statuses.has(k)));
  }, [rows, active]);

  return (
    <div className={styles.directory}>
      <div className={styles.dirOverdue} data-warn={overdueCount > 0 ? 'true' : 'false'}>
        {overdueCount > 0 ? `⚠ ${overdueCount} follow-up${overdueCount !== 1 ? 's' : ''} overdue` : 'No overdue follow-ups'}
      </div>
      <div className={styles.dirChips}>
        {STATUS_FILTERS.map(f => (
          <button key={f.key}
            className={`${styles.dirChip} ${active.has(f.key) ? styles.dirChipActive : ''}`}
            onClick={() => toggle(f.key)}>
            {f.label} <span className={styles.dirChipCount}>{counts[f.key]}</span>
          </button>
        ))}
      </div>
      <div className={styles.dirList}>
        {filtered.length === 0
          ? <div className={styles.dirEmpty}>No customers match.</div>
          : filtered.map(r => (
            <button key={r.customer.id} className={styles.dirRow} onClick={() => onSelect(r.customer.id)}>
              <div className={styles.dirRowName}>{r.customer.full_name}</div>
              <div className={styles.dirRowMeta}>
                {r.customer.onboard_date && <span>Onboarded {r.customer.onboard_date}</span>}
                {r.customer.email && <span>{r.customer.email}</span>}
              </div>
              <div className={styles.dirTags}>
                {[...r.statuses].map(k => (
                  <span key={k} className={styles.dirTag} data-status={k}>
                    {STATUS_FILTERS.find(f => f.key === k)?.label ?? k}
                  </span>
                ))}
                <span className={styles.dirFuState} style={{ color: FU_STATE_META[r.fuState].color, background: FU_STATE_META[r.fuState].bg }}>
                  {FU_STATE_META[r.fuState].label}
                </span>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
