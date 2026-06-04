import React, { useMemo, useState } from 'react';
import {
  useCustomers, syncCustomersFromHubspot, exportPurchasers, pushToKlaviyo,
  computeFuState, recordFollowUp, FU_STATE_META, FU1_DAYS, FU2_DAYS,
  type Customer, type FuState,
} from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import { formatMoney } from '../../lib/money';
import { useUnits } from '../../lib/stock';
import { useServiceTickets } from '../../lib/service';
import styles from './Customers.module.css';

export default function Customers() {
  const { customers, loading } = useCustomers();
  const { units } = useUnits();
  // Pre-build a lowercase-name → serial[] map so each row can render its
  // serial(s) without re-filtering the full units list.
  const serialsByCustomerName = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units) {
      if (!u.customer_name) continue;
      const key = u.customer_name.toLowerCase();
      const arr = m.get(key);
      if (arr) arr.push(u.serial);
      else m.set(key, [u.serial]);
    }
    return m;
  }, [units]);
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<'all' | 'CA' | 'US' | 'other'>('all');
  const [fuFilter, setFuFilter] = useState<'all' | 'needs_action' | FuState>('all');
  const [view, setView] = useState<'table' | 'calendar'>('table');
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });
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
      setToast(`Synced from HubSpot · ${r.inserted} new, ${r.filled} field${r.filled === 1 ? '' : 's'}-filled, ${r.touched} refreshed (${r.fetched} fetched, ${r.skipped} skipped)`);
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

  const handleKlaviyoPush = async (minusRefunds: boolean) => {
    const listId = window.prompt(
      `Klaviyo list ID for ${minusRefunds ? 'minus-refunds' : 'all-purchasers'} push?\n\n(Find in Klaviyo → Audience → Lists & Segments → list → Settings. Looks like 'R' + 6 chars.)`,
    );
    if (!listId?.trim()) return;
    setBusy(true); setError(null); setToast(null);
    try {
      const r = await pushToKlaviyo({
        list_id: listId.trim(),
        filter: minusRefunds ? 'minus_refunds' : 'all_purchasers',
      });
      setToast(`✓ Pushed ${r.pushed} profiles to Klaviyo list ${listId.trim()}${r.excluded ? ` (${r.excluded} excluded as refunded)` : ''}`);
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
          <button onClick={() => void handleKlaviyoPush(false)} disabled={busy} className={styles.exportBtn}>
            ↑ Push all → Klaviyo
          </button>
          <button onClick={() => void handleKlaviyoPush(true)} disabled={busy} className={styles.exportBtn}>
            ↑ Push minus refunds → Klaviyo
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
        <div className={styles.viewToggle}>
          <button
            onClick={() => setView('table')}
            className={`${styles.chip} ${view === 'table' ? styles.chipActive : ''}`}
          >Table</button>
          <button
            onClick={() => setView('calendar')}
            className={`${styles.chip} ${view === 'calendar' ? styles.chipActive : ''}`}
          >Calendar</button>
        </div>
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'row' : 'rows'}
        </div>
      </div>

      {view === 'table' ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Serial(s)</th>
                <th>Address</th>
                <th>Follow-up</th>
                <th>Last sync</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ c, fu }) => (
                <CustomerRow
                  key={c.id}
                  c={c}
                  fu={fu}
                  serials={
                    // Sheet is the source of truth: prefer the synced serials,
                    // fall back to the units-derived list when none are synced.
                    (c.serials && c.serials.length > 0)
                      ? c.serials
                      : (serialsByCustomerName.get(c.full_name?.toLowerCase() ?? '') ?? [])
                  }
                  onSelect={() => setSelectedCustomerId(c.id)}
                />
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className={styles.empty}>No customers match the filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <FollowUpCalendar
          month={calendarMonth}
          today={today}
          customers={customers}
          onPrev={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
          onNext={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
          onToday={() => setCalendarMonth(() => { const n = new Date(); n.setDate(1); n.setHours(0,0,0,0); return n; })}
          onCustomerClick={id => setSelectedCustomerId(id)}
        />
      )}
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

function CustomerRow({ c, fu, serials, onSelect }: { c: Customer; fu: FuState; serials: string[]; onSelect: () => void }) {
  const cityRegion = [c.city, c.region].filter(Boolean).join(', ');
  const fullAddrParts = [c.address_line, cityRegion, c.postal_code, c.country].filter(Boolean);
  const addr = fullAddrParts.join(' · ');
  const fuMeta = FU_STATE_META[fu];
  const serialsLabel = serials.length === 0
    ? null
    : serials.length === 1
      ? serials[0]
      : `${serials[0]} +${serials.length - 1}`;
  return (
    <tr onClick={onSelect} className={styles.clickableRow}>
      <td><strong>{c.full_name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{c.email ?? <span className={styles.muted}>—</span>}</td>
      <td>{c.phone ?? <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono} title={serials.join(', ')}>
        {serialsLabel ?? <span className={styles.muted}>—</span>}
      </td>
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
                    <span className={styles.itemAmount}>{formatMoney(o.total_usd, o.currency)}</span>
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

// ────────────────────────────────────────────────────────────────────────
// Monthly calendar grid (mirror of the standalone HTML calendar's view)
// ────────────────────────────────────────────────────────────────────────
const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

type CalEvent = {
  customer: Customer;
  kind: 'fu1' | 'fu2';
  dueDate: Date;     // onboard + FU1_DAYS or FU2_DAYS
  state: FuState;    // current state of this customer's overall FU
};

function FollowUpCalendar({
  month, today, customers,
  onPrev, onNext, onToday, onCustomerClick,
}: {
  month: Date;
  today: Date;
  customers: Customer[];
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onCustomerClick: (id: string) => void;
}) {
  // Compute the visible 6-week window
  const monthStart = new Date(month);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay()); // back up to Sunday
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42); // 6 weeks

  // Bucket events by yyyy-mm-dd
  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    for (const c of customers) {
      if (!c.onboard_date) continue;
      const onboard = new Date(c.onboard_date + 'T00:00:00');
      const fu1 = new Date(onboard); fu1.setDate(fu1.getDate() + FU1_DAYS);
      const fu2 = new Date(onboard); fu2.setDate(fu2.getDate() + FU2_DAYS);
      const state = computeFuState(c, today);
      // Only include events whose due date falls within the visible window
      for (const [kind, dueDate] of [['fu1', fu1], ['fu2', fu2]] as const) {
        if (dueDate < gridStart || dueDate >= gridEnd) continue;
        // Skip if this FU is already completed
        if (kind === 'fu1' && c.fu1_status) continue;
        if (kind === 'fu2' && !c.fu1_status) continue;  // FU2 only relevant after FU1 done
        if (kind === 'fu2' && c.fu2_status) continue;
        const k = key(dueDate);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push({ customer: c, kind, dueDate, state });
      }
    }
    return m;
  }, [customers, today, gridStart, gridEnd]);

  const todayKey = (() => {
    const d = today;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  })();

  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }

  return (
    <div className={styles.calWrap}>
      <div className={styles.calHeader}>
        <button className={styles.calNavBtn} onClick={onPrev} aria-label="Previous month">‹</button>
        <h3 className={styles.calMonth}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </h3>
        <button className={styles.calNavBtn} onClick={onNext} aria-label="Next month">›</button>
        <button className={styles.calTodayBtn} onClick={onToday}>Today</button>
      </div>
      <div className={styles.calLegend}>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotFu1}`} /> FU1
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotFu2}`} /> FU2
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotOverdue}`} /> Overdue
        </span>
      </div>
      <div className={styles.calGrid}>
        {WEEK_DAYS.map(d => (
          <div key={d} className={styles.calDayHeader}>{d}</div>
        ))}
        {days.map(d => {
          const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          const events = eventsByDay.get(k) ?? [];
          const isOtherMonth = d.getMonth() !== month.getMonth();
          const isToday = k === todayKey;
          const isPast = d < today && k !== todayKey;
          return (
            <div
              key={k}
              className={[
                styles.calDay,
                isOtherMonth ? styles.calDayOther : '',
                isToday ? styles.calDayToday : '',
              ].join(' ')}
            >
              <div className={styles.calDayNum}>{d.getDate()}</div>
              {events.map((ev, i) => {
                const overdue = isPast && !(ev.kind === 'fu1' ? ev.customer.fu1_status : ev.customer.fu2_status);
                return (
                  <button
                    key={i}
                    onClick={() => onCustomerClick(ev.customer.id)}
                    className={[
                      styles.calEvent,
                      overdue ? styles.calEventOverdue : (ev.kind === 'fu1' ? styles.calEventFu1 : styles.calEventFu2),
                    ].join(' ')}
                    title={`${ev.customer.full_name} — ${ev.kind.toUpperCase()} ${overdue ? 'overdue' : 'due'}`}
                  >
                    {ev.kind.toUpperCase()}: {ev.customer.full_name}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
