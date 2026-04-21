import { useMemo, useState } from 'react';
import {
  useReplacementQueue, assignReplacementSerial, clearReplacementAssignment,
  toggleReplPriority, updateReplStatus,
  type ReplQueueRow, type ReplQueueStatus,
} from '../../lib/postShipment';
import { useUnits } from '../../lib/stock';
import styles from './PostShipment.module.css';

export function ReplacementsTab() {
  const { queue, loading: qLoading } = useReplacementQueue();
  const { units, loading: uLoading } = useUnits();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Units that could be assigned to a queued replacement: ready or ca-test
  // in the preferred batch (default P100).
  const availableByBatch = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units) {
      if (u.status !== 'ready' && u.status !== 'ca-test') continue;
      const list = m.get(u.batch) ?? [];
      list.push(u.serial);
      m.set(u.batch, list);
    }
    for (const list of m.values()) list.sort();
    return m;
  }, [units]);

  const stats = useMemo(() => {
    const s = { total: 0, queued: 0, assigned: 0, priority: 0 };
    for (const r of queue) {
      s.total++;
      if (r.status === 'queued') s.queued++;
      if (r.status === 'assigned') s.assigned++;
      if (r.priority && r.status !== 'closed') s.priority++;
    }
    return s;
  }, [queue]);

  const handleAssign = async (row: ReplQueueRow, serial: string) => {
    if (!serial) return;
    setBusy(row.id); setError(null);
    try { await assignReplacementSerial(row.id, serial); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleClear = async (row: ReplQueueRow) => {
    setBusy(row.id); setError(null);
    try { await clearReplacementAssignment(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleTogglePri = async (row: ReplQueueRow) => {
    setBusy(row.id); setError(null);
    try { await toggleReplPriority(row.id, !row.priority); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const handleStatus = async (row: ReplQueueRow, next: ReplQueueStatus) => {
    setBusy(row.id); setError(null);
    try { await updateReplStatus(row.id, next); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  if (qLoading || uLoading) return <div className={styles.loading}>Loading replacement queue…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total in queue" value={stats.total} />
        <KPI label="Awaiting assign" value={stats.queued} tone={stats.queued > 0 ? 'warn' : undefined} />
        <KPI label="Assigned" value={stats.assigned} />
        <KPI label="Priority ⭐" value={stats.priority} />
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Preferred batch</th>
              <th>Original unit</th>
              <th>Priority</th>
              <th>Assigned serial</th>
              <th>Status</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {queue.map(row => {
              const pool = availableByBatch.get(row.batch_preference ?? 'P100') ?? [];
              const disabled = busy === row.id;
              return (
                <tr key={row.id} className={row.priority ? styles.rowPriority : ''}>
                  <td>{row.customer_name}</td>
                  <td className={styles.mono}>{row.batch_preference ?? '—'}</td>
                  <td className={styles.mono}>{row.original_unit_serial ?? <span className={styles.muted}>—</span>}</td>
                  <td>
                    <button
                      onClick={() => void handleTogglePri(row)}
                      disabled={disabled}
                      className={row.priority ? styles.priOn : styles.priOff}
                    >{row.priority ? '⭐ Clear' : '☆ Set'}</button>
                  </td>
                  <td>
                    {row.assigned_serial ? (
                      <span className={styles.assignedCell}>
                        <span className={styles.mono}>{row.assigned_serial}</span>
                        <button
                          className={styles.linkBtn}
                          onClick={() => void handleClear(row)}
                          disabled={disabled}
                        >clear</button>
                      </span>
                    ) : (
                      <select
                        defaultValue=""
                        onChange={e => void handleAssign(row, e.target.value)}
                        disabled={disabled || pool.length === 0}
                        className={styles.assignSelect}
                      >
                        <option value="">
                          {pool.length === 0 ? '— no stock —' : `Assign serial (${pool.length} avail)…`}
                        </option>
                        {pool.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    )}
                  </td>
                  <td>
                    <select
                      value={row.status}
                      onChange={e => void handleStatus(row, e.target.value as ReplQueueStatus)}
                      disabled={disabled}
                      className={styles.statusSelect}
                    >
                      <option value="queued">Queued</option>
                      <option value="assigned">Assigned</option>
                      <option value="shipped">Shipped</option>
                      <option value="closed">Closed</option>
                    </select>
                  </td>
                  <td className={styles.notes}>{row.notes ?? <span className={styles.muted}>—</span>}</td>
                  <td />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KPI({ label, value, tone }: { label: string; value: number | string; tone?: 'warn' }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'warn' ? styles.kpiWarn : ''}`}>{value}</div>
    </div>
  );
}
