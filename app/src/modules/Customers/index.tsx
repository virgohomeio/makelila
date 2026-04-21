import { useMemo, useState } from 'react';
import { useCustomers, syncCustomersFromHubspot, type Customer } from '../../lib/customers';
import styles from './Customers.module.css';

export default function Customers() {
  const { customers, loading } = useCustomers();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<'all' | 'CA' | 'US' | 'other'>('all');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter(c => {
      if (country === 'CA' && c.country !== 'CA') return false;
      if (country === 'US' && c.country !== 'US') return false;
      if (country === 'other' && (c.country === 'CA' || c.country === 'US')) return false;
      if (q && !(
        c.full_name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        c.city?.toLowerCase().includes(q) ||
        c.region?.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [customers, country, search]);

  const stats = useMemo(() => {
    const s = { total: 0, ca: 0, us: 0, other: 0, withEmail: 0, withPhone: 0, withAddress: 0 };
    let lastSync: number = 0;
    for (const c of customers) {
      s.total++;
      if (c.country === 'CA') s.ca++;
      else if (c.country === 'US') s.us++;
      else s.other++;
      if (c.email) s.withEmail++;
      if (c.phone) s.withPhone++;
      if (c.city || c.region || c.postal_code) s.withAddress++;
      if (c.last_synced_at) {
        const t = new Date(c.last_synced_at).getTime();
        if (t > lastSync) lastSync = t;
      }
    }
    return { ...s, lastSync: lastSync ? new Date(lastSync) : null };
  }, [customers]);

  const handleSync = async () => {
    setBusy(true); setError(null); setToast(null);
    try {
      const r = await syncCustomersFromHubspot();
      setToast(`Synced ${r.upserted} customer${r.upserted === 1 ? '' : 's'} (${r.fetched} fetched, ${r.skipped} skipped, ${r.pages} page${r.pages === 1 ? '' : 's'})`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className={styles.loading}>Loading customers…</div>;

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <h2 className={styles.title}>Customers</h2>
        <div className={styles.headerActions}>
          {stats.lastSync && (
            <span className={styles.lastSync}>
              Last HubSpot sync · {stats.lastSync.toLocaleString('en-US')}
            </span>
          )}
          <button onClick={handleSync} disabled={busy} className={styles.syncBtn}>
            {busy ? 'Syncing…' : '⟳ Sync from HubSpot'}
          </button>
        </div>
      </div>

      {toast && <div className={styles.toastSuccess}>{toast}</div>}
      {error && <div className={styles.toastError}>{error}</div>}

      <div className={styles.kpiRow}>
        <KPI label="Total customers" value={stats.total} />
        <KPI label="Canada / US" value={`${stats.ca} / ${stats.us}`} sub={stats.other > 0 ? `+ ${stats.other} other` : undefined} />
        <KPI label="With email" value={stats.withEmail} sub={stats.total > 0 ? `${Math.round((stats.withEmail / stats.total) * 100)}% coverage` : undefined} />
        <KPI label="With address" value={stats.withAddress} sub={stats.total > 0 ? `${Math.round((stats.withAddress / stats.total) * 100)}% coverage` : undefined} />
      </div>

      <div className={styles.filterBar}>
        {(['all','CA','US','other'] as const).map(c => (
          <button
            key={c}
            onClick={() => setCountry(c)}
            className={`${styles.chip} ${country === c ? styles.chipActive : ''}`}
          >{c === 'all' ? 'All' : c === 'other' ? 'Other' : c}</button>
        ))}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, phone, city…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'row' : 'rows'}
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Location</th>
              <th>HubSpot</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <CustomerRow key={c.id} c={c} />
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className={styles.empty}>No customers match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CustomerRow({ c }: { c: Customer }) {
  const loc = [c.city, c.region, c.country].filter(Boolean).join(', ');
  return (
    <tr>
      <td><strong>{c.full_name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{c.email ?? <span className={styles.muted}>—</span>}</td>
      <td>{c.phone ?? <span className={styles.muted}>—</span>}</td>
      <td>{loc || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>{c.hubspot_id ?? <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>
        {c.last_synced_at
          ? new Date(c.last_synced_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
          : <span className={styles.muted}>—</span>}
      </td>
    </tr>
  );
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
