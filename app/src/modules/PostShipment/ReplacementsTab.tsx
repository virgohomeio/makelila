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
    const now = Date.now();
    const batchNeed = new Map<string, number>(); // batch → count of queued
    let total = 0, queued = 0, assigned = 0, shipped = 0, priority = 0;
    let oldestQueued: number | null = null;
    for (const r of queue) {
      total++;
      if (r.status === 'queued') {
        queued++;
        const b = r.batch_preference ?? '?';
        batchNeed.set(b, (batchNeed.get(b) ?? 0) + 1);
        const t = new Date(r.created_at).getTime();
        if (oldestQueued === null || t < oldestQueued) oldestQueued = t;
      }
      if (r.status === 'assigned') assigned++;
      if (r.status === 'shipped')  shipped++;
      if (r.priority && r.status !== 'closed') priority++;
    }
    const oldestDays = oldestQueued !== null
      ? Math.floor((now - oldestQueued) / 86_400_000)
      : null;
    const fillRate = total > 0 ? Math.round(((assigned + shipped) / total) * 100) : 0;
    const batchNeedSummary = [...batchNeed.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, n]) => `${b}:${n}`)
      .join(' · ') || '—';
    return { total, queued, assigned, shipped, priority, oldestDays, fillRate, batchNeedSummary };
  }, [queue]);

  const availabilityVsNeed = useMemo(() => {
    // Per preferred batch: how many available units vs how many queued.
    // Surfaces "we don't have enough P100 to satisfy queue" at a glance.
    const need = new Map<string, number>();
    for (const r of queue) {
      if (r.status !== 'queued') continue;
      const b = r.batch_preference ?? 'P100';
      need.set(b, (need.get(b) ?? 0) + 1);
    }
    const out: { batch: string; available: number; needed: number; gap: number }[] = [];
    for (const [b, needed] of need) {
      const available = (availableByBatch.get(b) ?? []).length;
      out.push({ batch: b, available, needed, gap: available - needed });
    }
    return out.sort((a, b) => a.gap - b.gap);
  }, [queue, availableByBatch]);

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
        <KPI label="Total in queue" value={stats.total} sub={`${stats.fillRate}% filled`} />
        <KPI label="Awaiting assign" value={stats.queued} tone={stats.queued > 0 ? 'warn' : undefined} sub={stats.queued > 0 ? stats.batchNeedSummary : 'queue empty'} />
        <KPI label="Oldest waiting" value={stats.oldestDays !== null ? `${stats.oldestDays}d` : '—'} tone={stats.oldestDays !== null && stats.oldestDays > 14 ? 'warn' : undefined} sub={stats.oldestDays !== null ? 'days since queued' : undefined} />
        <KPI label="Priority ⭐" value={stats.priority} sub={stats.priority > 0 ? 'expedite needed' : 'normal'} />
      </div>

      {availabilityVsNeed.length > 0 && (
        <div className={styles.availStrip}>
          <span className={styles.availStripLabel}>Stock vs. need:</span>
          {availabilityVsNeed.map(a => (
            <span key={a.batch} className={a.gap < 0 ? styles.availGap : styles.availOk}>
              <strong>{a.batch}</strong>: {a.available} ready / {a.needed} queued
              {a.gap < 0 ? ` · ${Math.abs(a.gap)} short` : ` · +${a.gap} buffer`}
            </span>
          ))}
        </div>
      )}

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

function KPI({ label, value, tone, sub }: { label: string; value: number | string; tone?: 'warn'; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'warn' ? styles.kpiWarn : ''}`}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
