import { useMemo, useState } from 'react';
import { useUnits } from '../../lib/stock';
import styles from './PostShipment.module.css';

type BatchFilter = 'all' | 'P50' | 'P150' | 'P50N' | 'P100' | 'P100X';

const BATCHES: BatchFilter[] = ['all','P50','P150','P50N','P100','P100X'];

export function HistoryTab() {
  const { units, loading } = useUnits();
  const [search, setSearch] = useState('');
  const [batchFilter, setBatchFilter] = useState<BatchFilter>('all');

  const shipped = useMemo(
    () => units.filter(u => u.status === 'shipped'),
    [units],
  );

  const rows = useMemo(() => {
    const filtered = shipped.filter(u => {
      if (batchFilter !== 'all' && u.batch !== batchFilter) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        u.serial.toLowerCase().includes(q) ||
        u.customer_name?.toLowerCase().includes(q) ||
        u.customer_order_ref?.toLowerCase().includes(q) ||
        u.carrier?.toLowerCase().includes(q) ||
        u.location?.toLowerCase().includes(q)
      );
    });
    // Sort by shipped_at desc; rows with no shipped_at land at bottom.
    return [...filtered].sort((a, b) => {
      const ta = a.shipped_at ?? '';
      const tb = b.shipped_at ?? '';
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
  }, [shipped, batchFilter, search]);

  const stats = useMemo(() => {
    const now = Date.now();
    const d7  = now - 7  * 86_400_000;
    const d30 = now - 30 * 86_400_000;
    const perBatch: Record<string, number> = {};
    const customers = new Map<string, number>();
    let last7 = 0, last30 = 0, withDate = 0, undated = 0;
    let earliest = Infinity, latest = 0;
    let testCount = 0;
    for (const u of shipped) {
      perBatch[u.batch] = (perBatch[u.batch] ?? 0) + 1;
      if (u.customer_name?.toLowerCase().includes('(test)')) { testCount++; continue; }
      const c = u.customer_name ?? '—';
      customers.set(c, (customers.get(c) ?? 0) + 1);
      if (!u.shipped_at) { undated++; continue; }
      withDate++;
      const t = new Date(u.shipped_at).getTime();
      if (t < earliest) earliest = t;
      if (t > latest)   latest   = t;
      if (t >= d7)  last7++;
      if (t >= d30) last30++;
    }
    const days = earliest === Infinity ? 0 : Math.max(1, Math.round((latest - earliest) / 86_400_000));
    const perWeek = days > 0 ? +((withDate / days) * 7).toFixed(1) : 0;
    // Customers with multiple units = replacement chain
    const repeatCustomers = [...customers.entries()].filter(([, n]) => n > 1).length;
    const totalCustomers = customers.size;
    return {
      total: shipped.length, last7, last30, perBatch,
      perWeek, undated, testCount,
      latest: latest ? new Date(latest) : null,
      earliest: earliest === Infinity ? null : new Date(earliest),
      totalCustomers, repeatCustomers,
    };
  }, [shipped]);

  if (loading) return <div className={styles.loading}>Loading fulfillment history…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total shipped" value={stats.total} sub={stats.testCount > 0 ? `incl. ${stats.testCount} test` : undefined} />
        <KPI label="Last 30 days" value={stats.last30} sub={`${stats.last7} in last 7d`} />
        <KPI label="Velocity" value={`${stats.perWeek}/wk`} sub={stats.earliest ? `since ${formatDate(stats.earliest.toISOString())}` : undefined} />
        <KPI label="Unique customers" value={stats.totalCustomers} sub={stats.repeatCustomers > 0 ? `${stats.repeatCustomers} got replacements` : undefined} />
        <KPI label="By batch"
          value={`P50:${stats.perBatch.P50 ?? 0} · P150:${stats.perBatch.P150 ?? 0}`}
          sub={`P50N:${stats.perBatch.P50N ?? 0} · P100:${stats.perBatch.P100 ?? 0}`}
        />
        <KPI label="Undated rows" value={stats.undated} sub={stats.undated > 0 ? 'no shipped_at on file' : 'all dated'} />
      </div>

      <div className={styles.filterBar}>
        {BATCHES.map(b => (
          <button
            key={b}
            onClick={() => setBatchFilter(b)}
            className={`${styles.chip} ${batchFilter === b ? styles.chipActive : ''}`}
          >{b === 'all' ? 'All batches' : b}</button>
        ))}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, serial, carrier, location…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Shipped</th>
              <th>Customer</th>
              <th>Batch</th>
              <th>Color</th>
              <th>Serial</th>
              <th>Destination</th>
              <th>Carrier</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(u => (
              <tr key={u.serial}>
                <td className={styles.mono}>{formatDate(u.shipped_at)}</td>
                <td>{u.customer_name ?? <span className={styles.muted}>—</span>}</td>
                <td><span className={styles.batchBadge}>{u.batch}</span></td>
                <td>
                  {u.color ? (
                    <span className={styles.colorCell}>
                      <span
                        className={styles.colorDot}
                        style={{
                          background: u.color === 'Black' ? '#1a1a1a' : '#f5f5f5',
                          border: u.color === 'White' ? '1px solid #ccc' : 'none',
                        }}
                      />
                      {u.color}
                    </span>
                  ) : <span className={styles.muted}>—</span>}
                </td>
                <td className={styles.mono}>{u.serial}</td>
                <td>{u.location ?? <span className={styles.muted}>—</span>}</td>
                <td>{u.carrier ?? <span className={styles.muted}>—</span>}</td>
                <td className={styles.notes} title={u.notes ?? ''}>{u.notes ?? <span className={styles.muted}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function KPI({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
