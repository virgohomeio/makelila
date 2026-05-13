import { useMemo, useState } from 'react';
import {
  useReplacementQueue, assignReplacementSerial, clearReplacementAssignment,
  toggleReplPriority, updateReplStatus,
  type ReplQueueRow, type ReplQueueStatus,
} from '../../lib/postShipment';
import { useUnits } from '../../lib/stock';
import { useServiceTickets, type ServiceTicket } from '../../lib/service';
import styles from './PostShipment.module.css';

// Keyword detection for replacement requests in support ticket descriptions.
// Check parts first — "replacement filter" should classify as parts, not unit.
type ReplacementKind = 'parts' | 'unit' | 'both' | 'unclear';

function classifyReplacement(ticket: ServiceTicket): ReplacementKind | null {
  const text = `${ticket.subject ?? ''} ${ticket.description ?? ''}`.toLowerCase();
  const isParts = /\b(filter|starter|carbon|consumable|refill|kit|sleeve|gasket|parts?)\b/.test(text);
  const isUnit = /(replac\w*\s+(unit|composter|machine|lila)|new\s+(unit|composter|machine|lila)|send\s+\w+\s+new\s+(one|unit)|broken\s+(unit|composter|machine|lila)|won['’]?t\s+(turn|work|start|run)|doesn['’]?t\s+work|dead\s+(unit|machine|composter|lila)|swap\s+(unit|composter|machine))/.test(text);
  if (isParts && isUnit) return 'both';
  if (isParts) return 'parts';
  if (isUnit) return 'unit';
  if (/\breplac\w*\b/.test(text)) return 'unclear';
  return null;
}

const KIND_META: Record<ReplacementKind, { label: string; bg: string; color: string }> = {
  unit:    { label: 'Unit',    bg: '#fff5f5', color: '#c53030' },
  parts:   { label: 'Parts',   bg: '#ebf8ff', color: '#2b6cb0' },
  both:    { label: 'Both',    bg: '#faf5ff', color: '#553c9a' },
  unclear: { label: 'Unclear', bg: '#f7fafc', color: '#718096' },
};

export function ReplacementsTab() {
  const { queue, loading: qLoading } = useReplacementQueue();
  const { units, loading: uLoading } = useUnits();
  const { tickets } = useServiceTickets('support');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Open support tickets whose description signals a replacement request.
  // We don't auto-create replacement_queue rows — ops triages manually
  // after reading the full ticket.
  const replacementTickets = useMemo(() => {
    const open = tickets.filter(t => t.status !== 'resolved' && t.status !== 'closed');
    return open
      .map(t => ({ ticket: t, kind: classifyReplacement(t) }))
      .filter((x): x is { ticket: ServiceTicket; kind: ReplacementKind } => x.kind !== null)
      .sort((a, b) => {
        // unit > both > parts > unclear, then newest first
        const order: Record<ReplacementKind, number> = { unit: 0, both: 1, parts: 2, unclear: 3 };
        const k = order[a.kind] - order[b.kind];
        if (k !== 0) return k;
        return new Date(b.ticket.created_at).getTime() - new Date(a.ticket.created_at).getTime();
      });
  }, [tickets]);

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

      <IncomingFromSupport rows={replacementTickets} />

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

function IncomingFromSupport({ rows }: { rows: { ticket: ServiceTicket; kind: ReplacementKind }[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 14, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--color-ink-subtle)' }}>
          Incoming replacement requests (from Support Tickets)
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-ink-muted)' }}>{rows.length} open</span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Type</th>
            <th>Ticket #</th>
            <th>Customer</th>
            <th>Subject</th>
            <th>Description excerpt</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ticket, kind }) => {
            const meta = KIND_META[kind];
            const excerpt = (ticket.description ?? '').replace(/\s+/g, ' ').slice(0, 140);
            const daysOpen = Math.floor((Date.now() - new Date(ticket.created_at).getTime()) / 86_400_000);
            return (
              <tr key={ticket.id}>
                <td>
                  <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.3, background: meta.bg, color: meta.color }}>
                    {meta.label}
                  </span>
                </td>
                <td className={styles.mono}>{ticket.ticket_number}</td>
                <td>{ticket.customer_name ?? ticket.customer_email ?? '—'}</td>
                <td>{ticket.subject}</td>
                <td className={styles.notes} style={{ maxWidth: 360 }}>
                  {excerpt || <span className={styles.muted}>—</span>}
                  {excerpt && (ticket.description?.length ?? 0) > 140 ? '…' : ''}
                </td>
                <td>{daysOpen}d</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
