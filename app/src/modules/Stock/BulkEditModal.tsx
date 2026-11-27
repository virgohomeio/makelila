import { useMemo, useState } from 'react';
import {
  STATUS_META, STATUS_ORDER, getStatusMeta, bulkUpdateUnits,
  type Unit, type UnitStatus, type UnitChange, type BulkResult,
} from '../../lib/stock';
import styles from './Stock.module.css';

/** Change the status and/or location of many machines at once.
 *  Preview → confirm → result.
 *
 *  The preview is the point: before anything is written the operator sees
 *  where the selected machines are now, how many already match (skipped), and
 *  the side effects the per-row editors would warn about one at a time — a
 *  failed electrical test on the way to Ready, and the customer stamps that a
 *  move to Ready clears. */
export function BulkEditModal({
  units: unitsAtOpen, locationOptions = [], onClose, onDone,
}: {
  units: Unit[];
  /** Suggestions for the location field (existing + canonical locations). */
  locationOptions?: string[];
  onClose: () => void;
  /** Called after the run with the serials that actually changed. */
  onDone: (updated: string[]) => void;
}) {
  // Freeze the selection at open. Realtime updates land while the run is in
  // flight (and onDone shrinks the parent's selection), which would otherwise
  // reshuffle the preview and the counts under the operator.
  const [units] = useState(unitsAtOpen);
  const [target, setTarget] = useState<UnitStatus | ''>('');
  const [locationInput, setLocationInput] = useState('');
  const [skipElectricalFail, setSkipElectricalFail] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null && result === null;
  const location = locationInput.trim();

  const statusCounts = useMemo(() => countBy(units, u => u.status), [units]);
  const locationCounts = useMemo(() => countBy(units, u => u.location ?? ''), [units]);

  const plan = useMemo(() => {
    if (!target && !location) return null;
    const changes: UnitChange[] = [];
    let statusChanges = 0, locationChanges = 0;
    let alreadyStatus = 0, alreadyLocation = 0, electricalFail = 0, clearsCustomer = 0;
    for (const u of units) {
      const change: UnitChange = { serial: u.serial };
      if (target) {
        if (u.status === target) alreadyStatus++;
        else {
          const failed = target === 'ready' && u.electrical_check === 'fail';
          if (failed) electricalFail++;
          if (!(failed && skipElectricalFail)) {
            change.status = target;
            statusChanges++;
            if (target === 'ready' && (u.customer_name || u.customer_order_ref)) clearsCustomer++;
          }
        }
      }
      if (location) {
        if ((u.location ?? '') === location) alreadyLocation++;
        else { change.location = location; locationChanges++; }
      }
      if (change.status !== undefined || change.location !== undefined) changes.push(change);
    }
    return {
      changes, statusChanges, locationChanges,
      alreadyStatus, alreadyLocation, electricalFail, clearsCustomer,
    };
  }, [units, target, location, skipElectricalFail]);

  const run = async () => {
    if (!plan || plan.changes.length === 0) return;
    setError(null);
    setProgress({ done: 0, total: plan.changes.length });
    try {
      const res = await bulkUpdateUnits(plan.changes, {
        onProgress: (done, total) => setProgress({ done, total }),
      });
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
  const unitsWord = (k: number) => (k === 1 ? 'unit' : 'units');

  return (
    <div className={styles.modalBackdrop} onClick={running ? undefined : onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} role="dialog" aria-label="Bulk edit">
        <h3 className={styles.modalTitle}>
          Bulk edit · {units.length} {unitsWord(units.length)}
        </h3>

        {result ? (
          <>
            <div className={styles.bulkSummary}>
              Updated {result.updated.length} {unitsWord(result.updated.length)}.
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
              <div className={styles.modalLabel}>Status now</div>
              <div className={styles.bulkChips}>
                {statusCounts.map(([status, k]) => {
                  const meta = getStatusMeta(status);
                  return (
                    <span
                      key={status}
                      className={styles.bulkChip}
                      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
                    >{meta.label} · {k}</span>
                  );
                })}
              </div>
            </div>

            <div className={styles.modalField}>
              <div className={styles.modalLabel}>Location now</div>
              <div className={styles.bulkChips}>
                {locationCounts.map(([loc, k]) => (
                  <span key={loc || '(none)'} className={styles.bulkChip}>{loc || 'No location'} · {k}</span>
                ))}
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
                <option value="">Keep current status</option>
                {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>

            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="bulk-location">New location</label>
              <input
                id="bulk-location"
                value={locationInput}
                onChange={e => setLocationInput(e.target.value)}
                placeholder="Leave blank to keep current location"
                list="bulk-location-options"
                className={styles.modalInput}
                disabled={running}
              />
              <datalist id="bulk-location-options">
                {locationOptions.map(l => <option key={l} value={l} />)}
              </datalist>
              {location && (
                <div className={styles.modalHint}>
                  Sets the location Stock shows for each unit. Skid and pallet locations on the
                  Shelf board are not changed.
                </div>
              )}
            </div>

            {plan && (
              <div className={styles.modalField}>
                <ul className={styles.bulkPlan}>
                  <li><strong>{plan.changes.length}</strong> {unitsWord(plan.changes.length)} will be updated</li>
                  {target && (
                    <li>
                      {plan.statusChanges} → {targetLabel}
                      {plan.alreadyStatus > 0 && <> · {plan.alreadyStatus} already {targetLabel}</>}
                    </li>
                  )}
                  {location && (
                    <li>
                      {plan.locationChanges} → {location}
                      {plan.alreadyLocation > 0 && <> · {plan.alreadyLocation} already there</>}
                    </li>
                  )}
                  {plan.electricalFail > 0 && (
                    <li className={styles.bulkWarn}>
                      ⚠ {plan.electricalFail} {plan.electricalFail === 1 ? 'has' : 'have'} a
                      failed electrical test
                      <label className={styles.bulkCheck}>
                        <input
                          type="checkbox"
                          checked={skipElectricalFail}
                          onChange={e => setSkipElectricalFail(e.target.checked)}
                          disabled={running}
                        />
                        Don't mark them Ready
                      </label>
                    </li>
                  )}
                  {plan.clearsCustomer > 0 && (
                    <li className={styles.bulkWarn}>
                      ⚠ {plan.clearsCustomer} {plan.clearsCustomer === 1 ? 'has' : 'have'} a
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
                disabled={running || !plan || plan.changes.length === 0}
                className={styles.btnPrimary}
              >
                {running
                  ? 'Updating…'
                  : plan
                    ? `Update ${plan.changes.length} ${unitsWord(plan.changes.length)}`
                    : 'Update'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function countBy<T>(items: T[], key: (t: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
