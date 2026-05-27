import React, { useMemo, useState } from 'react';
import { useCustomers, syncCustomersFromHubspot, exportPurchasers, type Customer } from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import { useUnits } from '../../lib/stock';
import { useServiceTickets } from '../../lib/service';
import styles from './Customers.module.css';

export default function Customers() {
  const { customers, loading } = useCustomers();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<'all' | 'CA' | 'US' | 'other'>('all');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const selectedCustomer = useMemo(
    () => customers.find(c => c.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

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

  const handleExport = async (minusRefunds: boolean) => {
    setBusy(true); setError(null); setToast(null);
    try {
      const r = await exportPurchasers({ minusRefunds });
      const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `customers-${minusRefunds ? 'minus-refunds' : 'all-purchasers'}-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setToast(`Exported ${r.count} rows${minusRefunds ? ` (${r.excluded} excluded as refunded)` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className={styles.loading}>Loading customers…</div>;

  return (
    <>
    <div className={styles.layout}>
      <div className={styles.header}>
        <h2 className={styles.title}>Customers</h2>
        <div className={styles.headerActions}>
          {stats.lastSync && (
            <span className={styles.lastSync}>
              Last HubSpot sync · {stats.lastSync.toLocaleString('en-US')}
            </span>
          )}
          <button onClick={() => void handleExport(false)} disabled={busy} className={styles.exportBtn}>
            ↓ All purchasers (CSV)
          </button>
          <button onClick={() => void handleExport(true)} disabled={busy} className={styles.exportBtn}>
            ↓ Minus refunds (CSV)
          </button>
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
              <th>Address</th>
              <th>HubSpot</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <CustomerRow key={c.id} c={c} onSelect={() => setSelectedCustomerId(c.id)} />
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className={styles.empty}>No customers match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>

    {selectedCustomer && (
      <CustomerDetailPanel
        customer={selectedCustomer}
        onClose={() => setSelectedCustomerId(null)}
      />
    )}
    </>
  );
}

function CustomerRow({ c, onSelect }: { c: Customer; onSelect: () => void }) {
  const cityRegion = [c.city, c.region].filter(Boolean).join(', ');
  const fullAddrParts = [c.address_line, cityRegion, c.postal_code, c.country].filter(Boolean);
  const addr = fullAddrParts.join(' · ');
  return (
    <tr onClick={onSelect} className={styles.clickableRow}>
      <td><strong>{c.full_name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{c.email ?? <span className={styles.muted}>—</span>}</td>
      <td>{c.phone ?? <span className={styles.muted}>—</span>}</td>
      <td title={addr}>{addr || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>{c.hubspot_id ?? <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>
        {c.last_synced_at
          ? new Date(c.last_synced_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
          : <span className={styles.muted}>—</span>}
      </td>
    </tr>
  );
}

function CustomerDetailPanel({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { all: orders } = useOrders();
  const { units } = useUnits();
  const { tickets } = useServiceTickets();

  const lcEmail = customer.email?.toLowerCase() ?? '';
  const lcName = customer.full_name.toLowerCase();

  const myOrders = lcEmail
    ? orders.filter(o => o.customer_email?.toLowerCase() === lcEmail)
    : [];
  const myUnits = units.filter(u => u.customer_name?.toLowerCase() === lcName);
  const myTickets = lcEmail
    ? tickets.filter(t => t.customer_email?.toLowerCase() === lcEmail)
    : [];

  const cityRegion = [customer.city, customer.region].filter(Boolean).join(', ');
  const fullAddress = [customer.address_line, cityRegion, customer.postal_code, customer.country].filter(Boolean).join(', ');

  return (
    <div className={styles.panelBackdrop} onClick={onClose}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>{customer.full_name}</h2>
            <div className={styles.panelSubtitle}>{customer.email ?? 'no email'}</div>
          </div>
          <button onClick={onClose} className={styles.panelClose} aria-label="Close">×</button>
        </div>

        <div className={styles.panelBody}>
          <PanelSection title="Contact">
            <PanelRow label="Email" value={customer.email} />
            <PanelRow label="Phone" value={customer.phone} />
            <PanelRow label="Address" value={fullAddress} multiline />
          </PanelSection>

          <PanelSection title={`Orders (${myOrders.length})`}>
            {myOrders.length === 0
              ? <div className={styles.emptyRow}>No orders on file.</div>
              : myOrders.map(o => (
                  <div key={o.id} className={styles.itemRow}>
                    <span className={styles.mono}>{o.order_ref}</span>
                    <span className={styles.statusPill}>{o.status}</span>
                    <span className={styles.muted}>{o.placed_at ? new Date(o.placed_at).toLocaleDateString('en-US') : '—'}</span>
                    <span className={styles.itemAmount}>${o.total_usd.toFixed(2)}</span>
                  </div>
                ))
            }
          </PanelSection>

          <PanelSection title={`Shipped units (${myUnits.length})`}>
            {myUnits.length === 0
              ? <div className={styles.emptyRow}>No shipped units on file.</div>
              : myUnits.map(u => (
                  <div key={u.serial} className={styles.itemRow}>
                    <span className={styles.mono}>{u.serial}</span>
                    <span>{u.batch}</span>
                    <span className={styles.muted}>{u.shipped_at ? new Date(u.shipped_at).toLocaleDateString('en-US') : '—'}</span>
                    <span>{u.carrier ?? '—'}</span>
                  </div>
                ))
            }
          </PanelSection>

          <PanelSection title={`Service tickets (${myTickets.length})`}>
            {myTickets.length === 0
              ? <div className={styles.emptyRow}>No tickets on file.</div>
              : myTickets.map(t => (
                  <div key={t.id} className={styles.itemRow}>
                    <span>{t.subject}</span>
                    <span className={styles.muted}>{t.category}</span>
                    <span className={styles.muted}>{t.status}</span>
                  </div>
                ))
            }
          </PanelSection>
        </div>
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.sectionBody}>{children}</div>
    </div>
  );
}

function PanelRow({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={multiline ? styles.kvValueMulti : styles.kvValue}>{value || '—'}</span>
    </div>
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
