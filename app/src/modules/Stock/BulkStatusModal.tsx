import { useMemo, useState } from 'react';
import {
  STATUS_META, STATUS_ORDER, getStatusMeta, updateUnitsStatus,
  type Unit, type UnitStatus, type BulkStatusResult,
} from '../../lib/stock';
import styles from './Stock.module.css';

/** Change the status of many machines at once. Preview → confirm → result.
 *
 *  The preview is the point: before anything is written the operator sees
 *  where the selected machines are coming *from*, how many are already at the
 *  target (skipped), and the two side effects the per-row dropdown would warn
 *  about one at a time — a failed electrical test on the way to Ready, and the
 *  customer stamps that a move to Ready clears. */
export function BulkStatusModal({
  units: unitsAtOpen, onClose, onDone,
}: {
  units: Unit[];
  onClose: () => void;
  /** Called after the run with the serials that actually moved. */
  onDone: (updated: string[]) => void;
}) {
  // Freeze the selection at open. Realtime updates land while the run is in
  // flight (and onDone shrinks the parent's selection), which would otherwise
  // reshuffle the preview and the counts under the operator.
  const [units] = useState(unitsAtOpen);
  const [target, setTarget] = useState<UnitStatus | ''>('');
  const [skipElectricalFail, setSkipElectricalFail] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null && result === null;

  const fromCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of units) m.set(u.status, (m.get(u.status) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [units]);

  const plan = useMemo(() => {
    if (!target) return null;
    const alreadyThere = units.filter(u => u.status === target);
    const candidates = units.filter(u => u.status !== target);
    const electricalFail = target === 'ready'
      ? candidates.filter(u => u.electrical_check === 'fail')
      : [];
    const toChange = skipElectricalFail && electricalFail.length > 0
      ? candidates.filter(u => u.electrical_check !== 'fail')
      : candidates;
    const clearsCustomer = target === 'ready'
      ? toChange.filter(u => u.customer_name || u.customer_order_ref)
      : [];
    return { alreadyThere, electricalFail, toChange, clearsCustomer };
  }, [units, target, skipElectricalFail]);

  const run = async () => {
    if (!target || !plan || plan.toChange.length === 0) return;
    setError(null);
    setProgress({ done: 0, total: plan.toChange.length });
    try {
      const res = await updateUnitsStatus(
        plan.toChange.map(u => u.serial),
        target,
        { onProgress: (done, total) => setProgress({ done, total }) },
      );
      setResult(res);
      onDone(res.updated);
    } catch (e) {
      // Only reachable before any unit is written (e.g. not signed in) —
      // per-unit failures come back in the result instead.
      setError((e as Error).message);
      setProgress(null);
    }
  };

  const targetLabel = target ? STATUS_META[target].label : '';

  return (
    <div className={styles.modalBackdrop} onClick={running ? undefined : onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} role="dialog" aria-label="Change status">
        <h3 className={styles.modalTitle}>
          Change status · {units.length} {units.length === 1 ? 'unit' : 'units'}
        </h3>

        {result ? (
          <>
            <div className={styles.bulkSummary}>
              Updated {result.updated.length} {result.updated.length === 1 ? 'unit' : 'units'} to {targetLabel}.
            </div>
            {result.failed.length > 0 && (
              <div className={styles.modalField}>
                <div className={styles.modalLabel}>{result.failed.length} failed</div>
                <ul className={styles.bulkFailList}>
                  {result.failed.map(f => (
                    <li key={f.serial}><span className={styles.serial}>{f.serial}</span> — {f.message}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className={styles.modalActions}>
              <button onClick={onClose} className={styles.btnPrimary}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.modalField}>
              <div className={styles.modalLabel}>Currently</div>
              <div className={styles.bulkChips}>
                {fromCounts.map(([status, n]) => {
                  const meta = getStatusMeta(status);
                  return (
                    <span
                      key={status}
                      className={styles.bulkChip}
                      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
                    >{meta.label} · {n}</span>
                  );
                })}
              </div>
            </div>

            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="bulk-status-target">New status</label>
              <select
                id="bulk-status-target"
                value={target}
                onChange={e => setTarget(e.target.value as UnitStatus | '')}
                className={styles.modalInput}
                disabled={running}
              >
                <option value="">Choose…</option>
                {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>

            {plan && (
              <div className={styles.modalField}>
                <ul className={styles.bulkPlan}>
                  <li><strong>{plan.toChange.length}</strong> will change to {targetLabel}</li>
                  {plan.alreadyThere.length > 0 && (
                    <li>{plan.alreadyThere.length} already {targetLabel} — skipped</li>
                  )}
                  {plan.electricalFail.length > 0 && (
                    <li className={styles.bulkWarn}>
                      ⚠ {plan.electricalFail.length} {plan.electricalFail.length === 1 ? 'has' : 'have'} a
                      failed electrical test
                      <label className={styles.bulkCheck}>
                        <input
                          type="checkbox"
                          checked={skipElectricalFail}
                          onChange={e => setSkipElectricalFail(e.target.checked)}
                          disabled={running}
                        />
                        Skip them
                      </label>
                    </li>
                  )}
                  {plan.clearsCustomer.length > 0 && (
                    <li className={styles.bulkWarn}>
                      ⚠ {plan.clearsCustomer.length} {plan.clearsCustomer.length === 1 ? 'has' : 'have'} a
                      customer or order stamped — moving to Ready clears it
                    </li>
                  )}
                </ul>
              </div>
            )}

            {progress && (
              <div className={styles.modalHint}>Updating {progress.done} / {progress.total}…</div>
            )}
            {error && <div className={styles.modalError}>{error}</div>}

            <div className={styles.modalActions}>
              <button onClick={onClose} disabled={running} className={styles.btnSecondary}>Cancel</button>
              <button
                onClick={() => void run()}
                disabled={running || !plan || plan.toChange.length === 0}
                className={styles.btnPrimary}
              >
                {running
                  ? 'Updating…'
                  : plan
                    ? `Change ${plan.toChange.length} to ${targetLabel}`
                    : 'Change status'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
