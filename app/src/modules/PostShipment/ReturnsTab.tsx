import { useMemo, useState } from 'react';
import {
  useReturns, updateReturnStatus,
  RETURN_STATUS_META, RETURN_STATUS_ORDER,
  type ReturnStatus,
} from '../../lib/postShipment';
import styles from './PostShipment.module.css';

type StatusFilter = 'all' | 'open' | 'closed';

export function ReturnsTab() {
  const { returns, loading } = useReturns();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<Record<string, ReturnStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return returns.filter(r => {
      if (filter === 'open' && (r.status === 'refunded' || r.status === 'closed' || r.status === 'denied')) return false;
      if (filter === 'closed' && !(r.status === 'refunded' || r.status === 'closed' || r.status === 'denied')) return false;
      if (q && !(
        r.return_ref?.toLowerCase().includes(q) ||
        r.customer_name.toLowerCase().includes(q) ||
        r.unit_serial?.toLowerCase().includes(q) ||
        r.notes?.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [returns, filter, search]);

  const stats = useMemo(() => {
    const reasons = new Map<string, number>();
    const conditions = { unused: 0, used: 0, damaged: 0 };
    let total = 0, open = 0, refunded = 0, pending = 0, refundedUsd = 0;
    let canada = 0, usa = 0;
    let amounts: number[] = [];
    for (const r of returns) {
      total++;
      if (r.channel === 'Canada') canada++;
      else if (r.channel === 'USA') usa++;
      if (r.condition && conditions[r.condition] !== undefined) conditions[r.condition]++;
      if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
      if (r.status === 'refunded' || r.status === 'closed') {
        refunded++;
        const amt = Number(r.refund_amount_usd ?? 0);
        refundedUsd += amt;
        if (amt > 0) amounts.push(amt);
      } else {
        open++;
        if (r.status === 'received' || r.status === 'inspected') pending++;
      }
    }
    const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    const avgRefund = amounts.length > 0 ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : 0;
    return {
      total, open, refunded, pending, refundedUsd,
      canada, usa, conditions, topReason, avgRefund,
    };
  }, [returns]);

  const commit = async (id: string) => {
    const next = pending[id];
    if (!next) return;
    setBusy(id); setError(null);
    try {
      await updateReturnStatus(id, next);
      setPending(prev => {
        const { [id]: _, ...rest } = prev; void _;
        return rest;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className={styles.loading}>Loading returns…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total returns" value={stats.total} sub={`Canada ${stats.canada} · US ${stats.usa}`} />
        <KPI label="Open" value={stats.open} tone={stats.pending > 0 ? 'warn' : undefined} sub={stats.pending > 0 ? `${stats.pending} awaiting refund` : 'all advanced'} />
        <KPI label="Refunded $" value={`$${stats.refundedUsd.toLocaleString('en-US')}`} sub={`avg $${stats.avgRefund.toLocaleString('en-US')}/return`} />
        <KPI label="Top reason" value={stats.topReason ? stats.topReason[0] : '—'} sub={stats.topReason ? `${stats.topReason[1]} returns` : undefined} />
        <KPI label="By condition" value={`${stats.conditions.unused}u · ${stats.conditions.used}us · ${stats.conditions.damaged}d`} sub="unused / used / damaged" />
      </div>

      <div className={styles.filterBar}>
        {(['all','open','closed'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`${styles.chip} ${filter === f ? styles.chipActive : ''}`}
          >{f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Closed'}</button>
        ))}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search RTN #, customer, serial, note…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </div>
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>RTN #</th>
              <th>Customer</th>
              <th>Channel</th>
              <th>Unit</th>
              <th>Condition</th>
              <th>Reason</th>
              <th>Refund</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const statusVal = pending[r.id] ?? r.status;
              const meta = RETURN_STATUS_META[statusVal];
              const changed = statusVal !== r.status;
              return (
                <tr key={r.id}>
                  <td className={styles.mono}>{r.return_ref ?? '—'}</td>
                  <td>{r.customer_name}</td>
                  <td>{r.channel ?? '—'}</td>
                  <td className={styles.mono}>{r.unit_serial ?? <span className={styles.muted}>—</span>}</td>
                  <td>{r.condition ?? <span className={styles.muted}>—</span>}</td>
                  <td>{r.reason ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.num}>{r.refund_amount_usd != null ? `$${Number(r.refund_amount_usd).toLocaleString('en-US')}` : <span className={styles.muted}>—</span>}</td>
                  <td>
                    <select
                      value={statusVal}
                      onChange={e => setPending(prev => ({ ...prev, [r.id]: e.target.value as ReturnStatus }))}
                      className={styles.statusSelect}
                      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
                      disabled={busy === r.id}
                    >
                      {RETURN_STATUS_ORDER.map(s => (
                        <option key={s} value={s}>{RETURN_STATUS_META[s].label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {changed && (
                      <button
                        className={styles.updateBtn}
                        onClick={() => void commit(r.id)}
                        disabled={busy === r.id}
                      >{busy === r.id ? '…' : 'Update'}</button>
                    )}
                  </td>
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
