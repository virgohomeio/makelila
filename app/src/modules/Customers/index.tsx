import React, { useMemo, useState } from 'react';
import {
  useCustomers, syncCustomersFromHubspot, exportPurchasers,
  computeFuState, recordFollowUp, FU_STATE_META,
  type Customer, type FuState,
} from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import { useUnits } from '../../lib/stock';
import { useServiceTickets } from '../../lib/service';
import styles from './Customers.module.css';

export default function Customers() {
  const { customers, loading } = useCustomers();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<'all' | 'CA' | 'US' | 'other'>('all');
  const [fuFilter, setFuFilter] = useState<'all' | 'needs_action' | FuState>('all');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const today = useMemo(() => new Date(), []);
  const selectedCustomer = useMemo(
    () => customers.find(c => c.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

  // Compute fu state once per customer; reused by filter + render
  const withFu = useMemo(
    () => customers.map(c => ({ c, fu: computeFuState(c, today) })),
    [customers, today],
  );

  const fuCounts = useMemo(() => {
    const counts: Partial<Record<FuState, number>> = {};
    for (const { fu } of withFu) counts[fu] = (counts[fu] ?? 0) + 1;
    const needsAction =
      (counts.overdue_fu1 ?? 0) + (counts.overdue_fu2 ?? 0) +
      (counts.due_fu1 ?? 0) + (counts.due_fu2 ?? 0);
    return { ...counts, needsAction };
  }, [withFu]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return withFu.filter(({ c, fu }) => {
      if (country === 'CA' && c.country !== 'CA') return false;
      if (country === 'US' && c.country !== 'US') return false;
      if (country === 'other' && (c.country === 'CA' || c.country === 'US')) return false;
      if (fuFilter === 'needs_action') {
        if (!['overdue_fu1','overdue_fu2','due_fu1','due_fu2'].includes(fu)) return false;
      } else if (fuFilter !== 'all') {
        if (fu !== fuFilter) return false;
      }
      if (q && !(
        c.full_name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        c.city?.toLowerCase().includes(q) ||
        c.region?.toLowerCase().includes(q)
      )) return false;
      return true;
    }).sort((a, b) => {
      // Sort by FU urgency first when an FU filter is active or when viewing
      // 'needs_action'; otherwise keep the existing alphabetical order
      if (fuFilter !== 'all' && fuFilter !== 'needs_action') return 0;
      if (fuFilter === 'needs_action') {
        return FU_STATE_META[a.fu].sortKey - FU_STATE_META[b.fu].sortKey;
      }
      return a.c.full_name.localeCompare(b.c.full_name);
    });
  }, [withFu, country, search, fuFilter]);

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
        <span className={styles.filterDivider} />
        <button
          onClick={() => setFuFilter('all')}
          className={`${styles.chip} ${fuFilter === 'all' ? styles.chipActive : ''}`}
        >Any FU</button>
        <button
          onClick={() => setFuFilter('needs_action')}
          className={`${styles.chip} ${fuFilter === 'needs_action' ? styles.chipActive : ''}`}
          title="Overdue + due today, both FU1 and FU2"
        >Needs action {fuCounts.needsAction > 0 && <span className={styles.chipBadge}>{fuCounts.needsAction}</span>}</button>
        <button
          onClick={() => setFuFilter('overdue_fu1')}
          className={`${styles.chip} ${fuFilter === 'overdue_fu1' ? styles.chipActive : ''}`}
        >FU1 overdue {(fuCounts.overdue_fu1 ?? 0) > 0 && <span className={styles.chipBadge}>{fuCounts.overdue_fu1}</span>}</button>
        <button
          onClick={() => setFuFilter('overdue_fu2')}
          className={`${styles.chip} ${fuFilter === 'overdue_fu2' ? styles.chipActive : ''}`}
        >FU2 overdue {(fuCounts.overdue_fu2 ?? 0) > 0 && <span className={styles.chipBadge}>{fuCounts.overdue_fu2}</span>}</button>
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
              <th>Follow-up</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ c, fu }) => (
              <CustomerRow key={c.id} c={c} fu={fu} onSelect={() => setSelectedCustomerId(c.id)} />
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

function CustomerRow({ c, fu, onSelect }: { c: Customer; fu: FuState; onSelect: () => void }) {
  const cityRegion = [c.city, c.region].filter(Boolean).join(', ');
  const fullAddrParts = [c.address_line, cityRegion, c.postal_code, c.country].filter(Boolean);
  const addr = fullAddrParts.join(' · ');
  const fuMeta = FU_STATE_META[fu];
  return (
    <tr onClick={onSelect} className={styles.clickableRow}>
      <td><strong>{c.full_name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{c.email ?? <span className={styles.muted}>—</span>}</td>
      <td>{c.phone ?? <span className={styles.muted}>—</span>}</td>
      <td title={addr}>{addr || <span className={styles.muted}>—</span>}</td>
      <td>
        {fu === 'unscheduled' ? (
          <span className={styles.muted}>—</span>
        ) : (
          <span
            style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 4,
              color: fuMeta.color, background: fuMeta.bg, border: `1px solid ${fuMeta.color}33`,
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3,
            }}
          >{fuMeta.label}</span>
        )}
      </td>
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

          <FollowUpSection customer={customer} />

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
                  <div key={u.serial} className={styles.shippedUnitRow}>
                    <div className={styles.itemRow}>
                      <span className={styles.mono}>{u.serial}</span>
                      <span>{u.batch}</span>
                      <span className={styles.muted}>{u.shipped_at ? new Date(u.shipped_at).toLocaleDateString('en-US') : '—'}</span>
                      <span>{u.carrier ?? '—'}</span>
                    </div>
                    <div className={styles.trackingLine}>
                      Tracking:{' '}
                      {u.tracking_num
                        ? <span className={styles.mono}>{u.tracking_num}</span>
                        : <span className={styles.missingTracking}>missing</span>}
                    </div>
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

// ────────────────────────────────────────────────────────────────────────
// Follow-up section in the customer detail panel
// ────────────────────────────────────────────────────────────────────────
function FollowUpSection({ customer }: { customer: Customer }) {
  const fu = computeFuState(customer);
  const meta = FU_STATE_META[fu];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onboardFormatted = customer.onboard_date
    ? new Date(customer.onboard_date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  const handleRecord = async (kind: 'fu1' | 'fu2', status: string) => {
    setBusy(true); setErr(null);
    try {
      const note = window.prompt(`Optional note for ${kind.toUpperCase()} (${status}):`) ?? undefined;
      await recordFollowUp(customer.id, kind, status, note?.trim() || undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="Follow-up">
      <PanelRow
        label="Onboarded"
        value={onboardFormatted}
      />
      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>State</span>
        <span className={styles.kvValue}>
          <span
            style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 4,
              color: meta.color, background: meta.bg, border: `1px solid ${meta.color}33`,
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3,
            }}
          >{meta.label}</span>
        </span>
      </div>
      <PanelRow label="FU1" value={customer.fu1_status} />
      <PanelRow label="FU2" value={customer.fu2_status} />
      {customer.fu_notes && (
        <PanelRow label="Notes" value={customer.fu_notes} multiline />
      )}

      {customer.onboard_date && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!customer.fu1_status && (
            <>
              <button onClick={() => void handleRecord('fu1', 'called')}    disabled={busy} className={styles.fuBtn}>FU1: Called</button>
              <button onClick={() => void handleRecord('fu1', 'messaged')}  disabled={busy} className={styles.fuBtn}>FU1: Messaged</button>
              <button onClick={() => void handleRecord('fu1', 'completed')} disabled={busy} className={styles.fuBtn}>FU1: Done</button>
            </>
          )}
          {customer.fu1_status && !customer.fu2_status && (
            <>
              <button onClick={() => void handleRecord('fu2', 'called')}    disabled={busy} className={styles.fuBtn}>FU2: Called</button>
              <button onClick={() => void handleRecord('fu2', 'messaged')}  disabled={busy} className={styles.fuBtn}>FU2: Messaged</button>
              <button onClick={() => void handleRecord('fu2', 'reviewed')}  disabled={busy} className={styles.fuBtn}>FU2: Reviewed</button>
              <button onClick={() => void handleRecord('fu2', 'completed')} disabled={busy} className={styles.fuBtn}>FU2: Done</button>
            </>
          )}
        </div>
      )}
      {err && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-error, #c53030)' }}>Error: {err}</div>}
    </PanelSection>
  );
}
