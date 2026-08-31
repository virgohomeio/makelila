import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { isTelemetryConfigured } from '../../lib/supabaseTelemetry';
const Dashboard = lazy(() => import('../Dashboard'));
import {
  useCustomers, syncCustomersFromHubspot, exportPurchasers, pushToKlaviyo,
  setPurchaser, setPrimaryUser, updateCustomerContact, PRIMARY_USER_RELATIONSHIPS,
  useAllCustomerAdditionalUsers, matchCustomerSearch,
  type Customer, type CustomerAdditionalUser,
} from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import { formatMoney } from '../../lib/money';
import { useUnits } from '../../lib/stock';
import { useServiceTickets } from '../../lib/service';
import { Link, useSearchParams } from 'react-router-dom';
import { ProfitabilityTab } from './ProfitabilityTab';
import { JourneyTab } from './JourneyTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { NavCard } from '../../components/NavCard';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import { RouteErrorBoundary } from '../../components/RouteErrorBoundary';
import { useCustomerEvents, useCustomerEngagement, eventMeta, dormancyBadge } from '../../lib/customerEvents';
import { useCustomerInvoices, openInvoiceInNewTab } from '../../lib/invoices';
import { PanelSection, PanelRow } from './Panel';
import { NameSection } from './NameSection';
import { AdditionalUsersSection } from './AdditionalUsersSection';
import styles from './Customers.module.css';

type Tab = 'directory' | 'profitability' | 'journey' | 'fleet';

const TAB_KEYS: Tab[] = ['directory', 'profitability', 'journey', 'fleet'];

// Shared empty list for customers with no additional household users — keeps
// the search filter from allocating a new array per row on every keystroke.
const NO_HOUSEHOLD_USERS: CustomerAdditionalUser[] = [];

export default function Customers() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const p = searchParams.get('tab');
    return (TAB_KEYS as string[]).includes(p ?? '') ? (p as Tab) : 'journey';
  });
  const isMobile = useIsMobile();
  // On mobile, start with the tab picker visible. Tapping a card flips this
  // to `true` and the existing branches render the tab content with a
  // MobileBackHeader replacing the horizontal tab strip.
  const [mobileTabPicked, setMobileTabPicked] = useState(false);
  // Honour deep-links like /customers?tab=fleet&serial=… (e.g. from the header
  // notification bell) even when Customers is already mounted.
  const paramTab = searchParams.get('tab');
  useEffect(() => {
    if (paramTab && (TAB_KEYS as string[]).includes(paramTab)) {
      setTab(paramTab as Tab);
      setMobileTabPicked(true);
    }
  }, [paramTab]);
  const { customers, loading, refresh: refreshCustomers } = useCustomers();
  const { units } = useUnits();
  // Pre-build serial lookups so each row can render its serial(s) without
  // re-filtering the full units list. The canonical units.customer_id FK
  // (populated by the fulfillment-sheet sync, same link the Dashboard uses)
  // is preferred; the lowercase-name map is a fallback for any unit not yet
  // FK-linked.
  //
  // Only `shipped` units count as "currently held". A unit in rework/scrap/
  // ready/team-test is physically back with us, so listing it against the
  // customer is what made replaced units linger in the directory: after a
  // replacement the original moves to rework but the customer keeps showing
  // it. Filter here so both maps agree on the definition.
  const heldUnits = useMemo(() => units.filter(u => u.status === 'shipped'), [units]);
  const serialsByCustomerId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of heldUnits) {
      if (!u.customer_id) continue;
      const arr = m.get(u.customer_id);
      if (arr) arr.push(u.serial);
      else m.set(u.customer_id, [u.serial]);
    }
    return m;
  }, [heldUnits]);
  const serialsByCustomerName = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of heldUnits) {
      if (u.customer_id || !u.customer_name) continue;
      const key = u.customer_name.toLowerCase();
      const arr = m.get(key);
      if (arr) arr.push(u.serial);
      else m.set(key, [u.serial]);
    }
    return m;
  }, [heldUnits]);
  // Every household user in the directory, so the search box can look past the
  // purchaser's name (the per-customer hook only covers the open panel).
  const { byCustomerId: usersByCustomerId } = useAllCustomerAdditionalUsers();
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

  // Search reads the whole household, not just the purchaser: the name an
  // operator has been given is usually the person who USES the machine.
  // `via` says which of them matched, so a row that surfaced under a name the
  // Name column doesn't show still explains itself.
  const filtered = useMemo(() => {
    const rows: Array<{ customer: Customer; via: string | null }> = [];
    for (const c of customers) {
      if (country === 'CA' && c.country !== 'CA') continue;
      if (country === 'US' && c.country !== 'US') continue;
      if (country === 'other' && (c.country === 'CA' || c.country === 'US')) continue;
      const m = matchCustomerSearch(c, usersByCustomerId.get(c.id) ?? NO_HOUSEHOLD_USERS, search);
      if (!m.matched) continue;
      rows.push({ customer: c, via: m.via });
    }
    return rows.sort((a, b) => a.customer.full_name.localeCompare(b.customer.full_name));
  }, [customers, country, search, usersByCustomerId]);

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

  // Mobile: until a tab is picked, render a NavCard picker for the three
  // sub-views. After pick, fall through to the existing render branches with
  // a back affordance threaded in via MobileBackHeader. The Directory view is
  // dense (table + filters) — for V1 it just renders inside the existing
  // single-column layout.
  if (isMobile && !mobileTabPicked) {
    const pickerTabs: { key: Tab; label: string; subtitle: string; icon: string; iconBg: string }[] = [
      { key: 'journey',       label: 'Journey',       subtitle: '10-stage CJM · health per customer',           icon: '🛤️', iconBg: '#fef1f0' },
      { key: 'profitability', label: 'Profitability', subtitle: 'Revenue · returns · margin per customer',      icon: '💰', iconBg: '#fff3e0' },
      { key: 'directory',     label: 'Directory',     subtitle: 'All customers · search',     icon: '👥', iconBg: '#e3f0fb' },
      { key: 'fleet',         label: 'Fleet',         subtitle: 'Live device telemetry · machine health',         icon: '📡', iconBg: '#e3f0fb' },
    ];
    return (
      <div className={styles.layout}>
        <div className={styles.header}>
          <h2 className={styles.title}>Customers</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 4 }}>
          {pickerTabs.map(t => (
            <NavCard
              key={t.key}
              onClick={() => { setTab(t.key); setMobileTabPicked(true); }}
              title={t.label}
              subtitle={t.subtitle}
              icon={t.icon}
              iconBg={t.iconBg}
            />
          ))}
        </div>
      </div>
    );
  }

  // After picking on mobile, render MobileBackHeader at the top of each
  // branch instead of the desktop title-row + tabs strip. Tap the chevron
  // to return to the tab picker.
  const tabLabel =
    tab === 'journey'       ? 'Journey' :
    tab === 'profitability' ? 'Profitability' :
    tab === 'fleet'         ? 'Fleet' :
                              'Directory';
  const onMobileBack = () => setMobileTabPicked(false);

  if (tab === 'fleet') {
    if (!isTelemetryConfigured) {
      return (
        <div className={styles.layout}>
          {isMobile ? (
            <MobileBackHeader label={tabLabel} onBack={onMobileBack} />
          ) : (
            <div className={styles.header}>
              <div className={styles.titleRow}>
                <h2 className={styles.title}>Customers</h2>
                <CustomersTabs tab={tab} onChange={setTab} />
              </div>
            </div>
          )}
          <div style={{ padding: 24, color: '#4a5568' }}>
            <h2 style={{ marginTop: 0 }}>Telemetry not configured</h2>
            <p>Set <code>VITE_TELEMETRY_SUPABASE_URL</code> and <code>VITE_TELEMETRY_SUPABASE_ANON_KEY</code> in <code>.env</code> and reload.</p>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.layout}>
        {isMobile ? (
          <MobileBackHeader label={tabLabel} onBack={onMobileBack} />
        ) : (
          <div className={styles.header}>
            <div className={styles.titleRow}>
              <h2 className={styles.title}>Customers</h2>
              <CustomersTabs tab={tab} onChange={setTab} />
            </div>
          </div>
        )}
        <RouteErrorBoundary label="Fleet">
          <Suspense fallback={<div style={{ padding: 24 }}>Loading fleet…</div>}>
            <Dashboard />
          </Suspense>
        </RouteErrorBoundary>
      </div>
    );
  }

  if (tab === 'profitability') {
    return (
      <div className={styles.layout}>
        {isMobile ? (
          <MobileBackHeader label={tabLabel} onBack={onMobileBack} />
        ) : (
          <div className={styles.header}>
            <div className={styles.titleRow}>
              <h2 className={styles.title}>Customers</h2>
              <CustomersTabs tab={tab} onChange={setTab} />
            </div>
          </div>
        )}
        <ProfitabilityTab />
      </div>
    );
  }

  if (tab === 'journey') {
    return (
      <div className={styles.layout}>
        {isMobile ? (
          <MobileBackHeader label={tabLabel} onBack={onMobileBack} />
        ) : (
          <div className={styles.header}>
            <div className={styles.titleRow}>
              <h2 className={styles.title}>Customers</h2>
              <CustomersTabs tab={tab} onChange={setTab} />
            </div>
          </div>
        )}
        <JourneyTab />
      </div>
    );
  }

  return (
    <>
    <div className={styles.layout}>
      {isMobile && <MobileBackHeader label={tabLabel} onBack={onMobileBack} />}
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Customers</h2>
          {isMobile ? null : <CustomersTabs tab={tab} onChange={setTab} />}
        </div>
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

      <div className={styles.followupMoved}>
        Follow-ups now live in{' '}
        <Link to="/service?tab=followups">Service → Follow-Ups →</Link>
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
          placeholder="Search any name on the record, email, phone, city…"
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
              <th>Serial(s)</th>
              <th>Address</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ customer: c, via }) => (
              <CustomerRow
                key={c.id}
                c={c}
                via={via}
                serials={
                  // Stock is the source of truth for what a customer holds
                  // today: prefer the canonical units.customer_id link, then
                  // name-matching for units not yet FK-linked. customers.serials
                  // is a denormalised snapshot of the fulfilment sheet that only
                  // refreshes when sync_customer_serials_from_fulfillment() is
                  // run, so it goes stale the moment a replacement ships — it is
                  // now only a last resort for customers with no unit row at all.
                  serialsByCustomerId.get(c.id)
                    ?? serialsByCustomerName.get(c.full_name?.toLowerCase() ?? '')
                    ?? c.serials
                    ?? []
                }
                onSelect={() => setSelectedCustomerId(c.id)}
              />
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
        allCustomers={customers}
        onChanged={() => { void refreshCustomers(); }}
        onClose={() => setSelectedCustomerId(null)}
      />
    )}
    </>
  );
}

function CustomerRow(
  { c, serials, via, onSelect }:
  { c: Customer; serials: string[]; via: string | null; onSelect: () => void },
) {
  const cityRegion = [c.city, c.region].filter(Boolean).join(', ');
  const fullAddrParts = [c.address_line, cityRegion, c.postal_code, c.country].filter(Boolean);
  const addr = fullAddrParts.join(' · ');
  const serialsLabel = serials.length === 0
    ? null
    : serials.length === 1
      ? serials[0]
      : `${serials[0]} +${serials.length - 1}`;
  return (
    <tr onClick={onSelect} className={styles.clickableRow}>
      <td>
        <strong>{c.full_name || <span className={styles.muted}>—</span>}</strong>
        {/* Why this row is in the results when the name searched for isn't the
            purchaser's. */}
        {via && <div className={styles.viaMatch}>via {via}</div>}
      </td>
      <td className={styles.mono}>{c.email ?? <span className={styles.muted}>—</span>}</td>
      <td>{c.phone ?? <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono} title={serials.join(', ')}>
        {serialsLabel ?? <span className={styles.muted}>—</span>}
      </td>
      <td title={addr}>{addr || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>
        {c.last_synced_at
          ? new Date(c.last_synced_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
          : <span className={styles.muted}>—</span>}
      </td>
    </tr>
  );
}

// Contact details — read-only until you hit Edit. Email and phone are
// operator-editable here: makelila is the system of record and the HubSpot sync
// only fills BLANK columns, so a correction made here is never clobbered.
// Address stays read-only (it's per-order on the Order Review side).
function ContactSection({ customer, onChanged }: { customer: Customer; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(customer.email ?? '');
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset the draft whenever we switch customer or the row changes underneath us.
  useEffect(() => {
    setEditing(false);
    setEmail(customer.email ?? '');
    setPhone(customer.phone ?? '');
    setErr(null);
  }, [customer.id, customer.email, customer.phone]);

  const cityRegion = [customer.city, customer.region].filter(Boolean).join(', ');
  const fullAddress = [customer.address_line, cityRegion, customer.postal_code, customer.country]
    .filter(Boolean).join(', ');

  // Compare case-insensitively: we store lowercased, but rows seeded before that
  // may hold mixed case, and re-typing the same address shouldn't read as a change.
  const emailChanged =
    (email.trim().toLowerCase() || null) !== (customer.email?.trim().toLowerCase() ?? null);
  const dirty = emailChanged || (phone.trim() || null) !== (customer.phone ?? null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await updateCustomerContact(customer.id, { email, phone });
      setEditing(false);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const cancel = () => {
    setEmail(customer.email ?? '');
    setPhone(customer.phone ?? '');
    setErr(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <PanelSection title="Contact">
        <PanelRow label="Email" value={customer.email} />
        <PanelRow label="Phone" value={customer.phone} />
        <PanelRow label="Address" value={fullAddress} multiline />
        <div style={{ marginTop: 6 }}>
          <button className={styles.linkBtn} onClick={() => setEditing(true)}>
            Edit email / phone
          </button>
        </div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Contact">
      <div className={styles.kvLabel} style={{ marginBottom: 4 }}>
        Email
      </div>
      <input className={styles.searchInput} type="email" placeholder="name@example.com"
        value={email} disabled={busy} onChange={e => setEmail(e.target.value)} />
      <div className={styles.kvLabel} style={{ margin: '6px 0 4px' }}>
        Phone
      </div>
      <input className={styles.searchInput} type="tel" placeholder="e.g. 519-555-0142"
        value={phone} disabled={busy} onChange={e => setPhone(e.target.value)} />
      {emailChanged && (
        <div className={styles.kvLabel} style={{ marginTop: 6 }}>
          ⚠ Orders, tickets and refund cards are matched to this customer by email —
          changing it re-points which of those show up on this record.
        </div>
      )}
      <PanelRow label="Address" value={fullAddress} multiline />
      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <button className={styles.linkBtn} disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className={styles.linkBtn} disabled={busy} onClick={cancel}>Cancel</button>
      </div>
      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}
    </PanelSection>
  );
}

// FR-6: link a USER (submitter / gift recipient / household member) to the
// PURCHASER of record. Refunds and accounting resolve to the purchaser, so this
// is where operators fix the Lily Xu → Annie Wu class of case.
function PurchaserLinkSection({ customer, allCustomers, onChanged }: {
  customer: Customer;
  allCustomers: Customer[];
  onChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const purchaser = customer.purchaser_id
    ? allCustomers.find(c => c.id === customer.purchaser_id) ?? null
    : null;
  const linkedUsers = useMemo(
    () => allCustomers.filter(c => c.purchaser_id === customer.id),
    [allCustomers, customer.id],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return allCustomers
      .filter(c => c.id !== customer.id && (
        c.full_name.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)
      ))
      .slice(0, 8);
  }, [query, allCustomers, customer.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); setQuery(''); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const label = (c: Customer) => `${c.full_name || '—'}${c.email ? ` · ${c.email}` : ''}`;

  return (
    <PanelSection title="Purchaser & users">
      {purchaser ? (
        <div className={styles.kvRow}>
          <span className={styles.kvLabel}>Acts for purchaser</span>
          <span className={styles.kvValue}>
            {label(purchaser)}{' '}
            <button className={styles.linkBtn} disabled={busy}
              onClick={() => void run(() => setPurchaser(customer.id, null))}>Unlink</button>
          </span>
        </div>
      ) : (
        <>
          <div className={styles.kvRow}>
            <span className={styles.kvLabel}>Purchaser of record</span>
            <span className={styles.kvValue}>This customer is the purchaser.</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <input
              className={styles.searchInput}
              placeholder="Link to a purchaser — type name or email…"
              value={query}
              disabled={busy}
              onChange={e => setQuery(e.target.value)}
            />
            {matches.length > 0 && (
              <div className={styles.section} style={{ marginTop: 4 }}>
                {matches.map(m => (
                  <div key={m.id} className={styles.kvRow}>
                    <span className={styles.kvValue}>{label(m)}</span>
                    <button className={styles.linkBtn} disabled={busy}
                      onClick={() => void run(() => setPurchaser(customer.id, m.id))}>Link →</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {linkedUsers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className={styles.kvLabel}>Linked users ({linkedUsers.length})</div>
          {linkedUsers.map(u => (
            <div key={u.id} className={styles.kvRow}>
              <span className={styles.kvValue}>{label(u)}</span>
              <button className={styles.linkBtn} disabled={busy}
                onClick={() => void run(() => setPurchaser(u.id, null))}>Unlink</button>
            </div>
          ))}
        </div>
      )}

      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}
    </PanelSection>
  );
}

// FR-6: the PRIMARY USER of this customer's machine (e.g. a spouse) when
// different from the purchaser. Free-text — usually not a customer of record.
// Set here; surfaced on the refund card. Example: Chad (purchaser) → Sarah.
//
// The relationship picklist is PRIMARY_USER_RELATIONSHIPS; this sentinel is the
// escape hatch. It is never stored — picking it just reveals the free-text box,
// and what gets saved is whatever was typed there.
const OTHER_RELATIONSHIP = 'Other…';

function PrimaryUserSection({ customer, onChanged }: { customer: Customer; onChanged: () => void }) {
  const [name, setName] = useState(customer.primary_user_name ?? '');
  const [phone, setPhone] = useState(customer.primary_user_phone ?? '');
  const [email, setEmail] = useState(customer.primary_user_email ?? '');
  // The stored relationship is free text. If it isn't one of the picklist
  // values it's an "Other…" entry, so the select shows Other and the text box
  // carries the value.
  const storedRel = customer.primary_user_relationship ?? '';
  const isListed = (v: string) => (PRIMARY_USER_RELATIONSHIPS as readonly string[]).includes(v);
  const [relChoice, setRelChoice] = useState(
    storedRel === '' ? '' : isListed(storedRel) ? storedRel : OTHER_RELATIONSHIP,
  );
  const [relOther, setRelOther] = useState(storedRel && !isListed(storedRel) ? storedRel : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setName(customer.primary_user_name ?? '');
    setPhone(customer.primary_user_phone ?? '');
    setEmail(customer.primary_user_email ?? '');
    const rel = customer.primary_user_relationship ?? '';
    setRelChoice(rel === '' ? '' : isListed(rel) ? rel : OTHER_RELATIONSHIP);
    setRelOther(rel && !isListed(rel) ? rel : '');
  }, [customer.id, customer.primary_user_name, customer.primary_user_phone,
      customer.primary_user_email, customer.primary_user_relationship]);

  // What we'd actually store: the picked option, or the free text behind "Other…".
  const relationship = relChoice === OTHER_RELATIONSHIP ? relOther.trim() : relChoice;

  const dirty =
    (name.trim() || null) !== (customer.primary_user_name ?? null) ||
    (phone.trim() || null) !== (customer.primary_user_phone ?? null) ||
    (email.trim() || null) !== (customer.primary_user_email ?? null) ||
    (relationship || null) !== (customer.primary_user_relationship ?? null);

  const save = async (clear?: boolean) => {
    setBusy(true); setErr(null);
    try {
      await setPrimaryUser(
        customer.id,
        clear ? null : name,
        clear ? null : phone,
        clear ? null : email,
        clear ? null : relationship,
      );
      if (clear) { setName(''); setPhone(''); setEmail(''); setRelChoice(''); setRelOther(''); }
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <PanelSection title="Primary user of the machine">
      <div className={styles.kvLabel} style={{ marginBottom: 4 }}>
        Who actually uses the machine, when different from the purchaser (e.g. a spouse), and how they
        relate to the purchaser. Shown on the refund card.
      </div>
      <input className={styles.searchInput} placeholder="Primary user name (e.g. Sarah Lockhart)"
        value={name} disabled={busy} onChange={e => setName(e.target.value)} />
      <input className={styles.searchInput} style={{ marginTop: 4 }} type="tel" placeholder="Primary user phone (optional)"
        value={phone} disabled={busy} onChange={e => setPhone(e.target.value)} />
      <input className={styles.searchInput} style={{ marginTop: 4 }} type="email" placeholder="Primary user email (optional)"
        value={email} disabled={busy} onChange={e => setEmail(e.target.value)} />
      <select className={styles.searchInput} style={{ marginTop: 4 }}
        value={relChoice} disabled={busy}
        onChange={e => setRelChoice(e.target.value)}
        aria-label="Primary user's relationship to the purchaser">
        <option value="">Relationship to purchaser (optional)…</option>
        {PRIMARY_USER_RELATIONSHIPS.map(r => <option key={r} value={r}>{r}</option>)}
        <option value={OTHER_RELATIONSHIP}>{OTHER_RELATIONSHIP}</option>
      </select>
      {relChoice === OTHER_RELATIONSHIP && (
        <input className={styles.searchInput} style={{ marginTop: 4 }}
          placeholder="Describe the relationship (e.g. neighbour)"
          value={relOther} disabled={busy} onChange={e => setRelOther(e.target.value)} />
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
        <button className={styles.linkBtn} disabled={busy || !dirty} onClick={() => void save()}>Save</button>
        {(customer.primary_user_name || customer.primary_user_phone || customer.primary_user_email
          || customer.primary_user_relationship) && (
          <button className={styles.linkBtn} disabled={busy} onClick={() => void save(true)}>Clear</button>
        )}
      </div>
      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}
    </PanelSection>
  );
}

function CustomerDetailPanel({ customer, allCustomers, onChanged, onClose }: {
  customer: Customer;
  allCustomers: Customer[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const { all: orders } = useOrders();
  const { units } = useUnits();
  const { tickets } = useServiceTickets();
  const lcEmail = customer.email?.toLowerCase() ?? '';
  const lcName = customer.full_name.toLowerCase();

  const myOrders = lcEmail
    ? orders.filter(o => o.customer_email?.toLowerCase() === lcEmail)
    : [];
  // Prefer the canonical units.customer_id link (populated by the
  // fulfillment-sheet sync, same association the Dashboard uses); fall back to
  // name-matching only for units not yet FK-linked, so a unit with a known FK
  // never shows up under the wrong customer.
  const myUnits = units.filter(u =>
    u.customer_id
      ? u.customer_id === customer.id
      : u.customer_name?.toLowerCase() === lcName);
  const myTickets = lcEmail
    ? tickets.filter(t => t.customer_email?.toLowerCase() === lcEmail)
    : [];

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
          <NameSection customer={customer} onChanged={onChanged} />
          <ContactSection customer={customer} onChanged={onChanged} />

          <PurchaserLinkSection customer={customer} allCustomers={allCustomers} onChanged={onChanged} />
          <PrimaryUserSection customer={customer} onChanged={onChanged} />
          <AdditionalUsersSection customerId={customer.id} />

          <LilaAppActivitySection customerId={customer.id} />

          <PanelSection title={`Orders (${myOrders.length})`}>
            {myOrders.length === 0
              ? <div className={styles.emptyRow}>No orders on file.</div>
              : myOrders.map(o => (
                  <div key={o.id} className={styles.orderCard}>
                    <div className={styles.orderCardHeader}>
                      <span className={styles.mono}>{o.order_ref}</span>
                      <span className={styles.statusPill}>{o.status}</span>
                      {o.financial_status && (
                        <span className={styles.muted} style={{ fontSize: 11 }}>{o.financial_status}</span>
                      )}
                      <span className={styles.muted}>{o.placed_at ? new Date(o.placed_at).toLocaleDateString('en-US') : '—'}</span>
                    </div>
                    {o.payment_methods && o.payment_methods.length > 0 && (
                      <div className={styles.orderCardRow}>
                        <span className={styles.kvLabel}>Payment</span>
                        <span>{o.payment_methods.join(', ')}</span>
                      </div>
                    )}
                    {o.shipping_line_title && (
                      <div className={styles.orderCardRow}>
                        <span className={styles.kvLabel}>Shipping method</span>
                        <span>{o.shipping_line_title}</span>
                      </div>
                    )}
                    <div className={styles.orderFinancials}>
                      {o.subtotal_usd != null && (
                        <div className={styles.orderCardRow}>
                          <span className={styles.kvLabel}>Subtotal</span>
                          <span>{formatMoney(o.subtotal_usd, o.currency)}</span>
                        </div>
                      )}
                      {o.discount_total_usd != null && o.discount_total_usd > 0 && (
                        <div className={styles.orderCardRow}>
                          <span className={styles.kvLabel}>
                            Discount
                            {o.discount_codes && o.discount_codes.length > 0
                              ? ` (${o.discount_codes.join(', ')})`
                              : ''}
                          </span>
                          <span style={{ color: 'var(--color-success)' }}>
                            −{formatMoney(o.discount_total_usd, o.currency)}
                          </span>
                        </div>
                      )}
                      {o.customer_paid_shipping_usd != null && (
                        <div className={styles.orderCardRow}>
                          <span className={styles.kvLabel}>Shipping paid</span>
                          <span>{formatMoney(o.customer_paid_shipping_usd, o.currency)}</span>
                        </div>
                      )}
                      {o.tax_lines && o.tax_lines.length > 0
                        ? o.tax_lines.map((tl, i) => (
                            <div key={i} className={styles.orderCardRow}>
                              <span className={styles.kvLabel}>{tl.title} ({Math.round(tl.rate * 100)}%)</span>
                              <span>{formatMoney(tl.amount_usd, o.currency)}</span>
                            </div>
                          ))
                        : o.tax_usd != null && o.tax_usd > 0 && (
                            <div className={styles.orderCardRow}>
                              <span className={styles.kvLabel}>Tax</span>
                              <span>{formatMoney(o.tax_usd, o.currency)}</span>
                            </div>
                          )
                      }
                      <div className={styles.orderCardRow} style={{ fontWeight: 600, borderTop: '1px solid var(--border)' }}>
                        <span className={styles.kvLabel}>Total</span>
                        <span>{formatMoney(o.total_usd, o.currency)}</span>
                      </div>
                    </div>
                    {o.line_items && o.line_items.length > 0 && (
                      <div className={styles.orderLineItems}>
                        {o.line_items.map((li, i) => {
                          const unitPrice = 'price_usd' in li ? li.price_usd : ('cost_per_unit_usd' in li ? li.cost_per_unit_usd : ('cost_usd' in li ? li.cost_usd : 0));
                          return (
                            <div key={i} className={styles.orderCardRow} style={{ fontSize: 11 }}>
                              <span className={styles.muted}>{li.qty}× {li.name}</span>
                              <span className={styles.muted}>{formatMoney(unitPrice * li.qty, o.currency)}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
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

          <CustomerInvoicesSection customerId={customer.id} />
        </div>
      </div>
    </div>
  );
}

// Customer-side signals from the lilalovely app (beta-lovely). Backed by
// customer_events + customer_engagement_summary; populated by the
// ingest-lovely-event edge function. Renders engagement summary + the last
// 8 events as a compact timeline. Empty state covers two cases:
//   - customer hasn't signed up for the lilalovely app yet (no link row)
//   - customer signed up but hasn't generated any events yet
// Spec: docs/integration-lilalovely-2026-06-07.md
function LilaAppActivitySection({ customerId }: { customerId: string }) {
  const { summary, loading: sLoading } = useCustomerEngagement(customerId);
  const { events, loading: eLoading } = useCustomerEvents(customerId);
  const loading = sLoading || eLoading;
  const badge = dormancyBadge(summary?.dormancy_days ?? null);

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Lila app activity</span>
        {badge && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 999,
            fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3,
            color:
              badge.tone === 'good'  ? 'var(--color-success)' :
              badge.tone === 'warn'  ? 'var(--color-warning)' :
                                       'var(--color-error)',
            background:
              badge.tone === 'good'  ? 'var(--color-success-bg)' :
              badge.tone === 'warn'  ? 'var(--color-warning-bg)' :
                                       'var(--color-error-bg)',
          }}>{badge.label}</span>
        )}
      </div>
      <div className={styles.sectionBody}>
        {loading ? (
          <div className={styles.emptyRow}>Loading app activity…</div>
        ) : !summary?.lovely_user_id ? (
          <div className={styles.emptyRow}>
            Not yet signed up for the lilalovely app.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
              <span><strong>{summary.events_7d}</strong> <span className={styles.muted}>events (7d)</span></span>
              <span><strong>{summary.events_30d}</strong> <span className={styles.muted}>events (30d)</span></span>
              {summary.app_last_seen_at && (
                <span>
                  <span className={styles.muted}>Last seen </span>
                  <strong>{new Date(summary.app_last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</strong>
                </span>
              )}
            </div>
            {events.length === 0 ? (
              <div className={styles.emptyRow}>No events recorded yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {events.slice(0, 8).map(e => {
                  const meta = eventMeta(e.event_type);
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{meta.label}</span>
                      <span className={styles.muted} style={{ fontSize: 11 }}>
                        {new Date(e.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Invoices & refund receipts filed against this customer by the Upload module.
// Auto-matched from the Shopify order # on the PDF (or assigned manually from
// the Upload review queue).
function CustomerInvoicesSection({ customerId }: { customerId: string }) {
  const { invoices, loading } = useCustomerInvoices(customerId);

  const view = async (path: string) => {
    try { await openInvoiceInNewTab(path); }
    catch (e) { alert((e as Error).message); }
  };

  return (
    <PanelSection title={`Invoices (${invoices.length})`}>
      {loading ? (
        <div className={styles.emptyRow}>Loading invoices…</div>
      ) : invoices.length === 0 ? (
        <div className={styles.emptyRow}>No invoices on file. Upload them in the Upload tab.</div>
      ) : (
        invoices.map(inv => (
          <div key={inv.id} className={styles.itemRow}>
            <span className={styles.mono}>#{inv.invoice_number}</span>
            <span className={styles.muted}>
              {inv.document_type === 'refund_receipt' ? 'Refund receipt' : 'Invoice'}
            </span>
            {inv.order_ref && <span className={styles.mono}>{inv.order_ref}</span>}
            <span className={styles.muted}>
              {inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-US') : '—'}
            </span>
            <span className={styles.itemAmount}>
              {inv.total_cad != null ? formatMoney(inv.total_cad, 'CAD') : '—'}
            </span>
            <button
              onClick={() => void view(inv.storage_path)}
              style={{ background: 'none', border: 'none', color: 'var(--color-crimson)', cursor: 'pointer', textDecoration: 'underline', fontSize: 12, padding: 0 }}
            >View</button>
          </div>
        ))
      )}
    </PanelSection>
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

function CustomersTabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  // Order per operator (2026-06-05): Journey first (default), Profitability,
  // Directory last.
  const tabs: { key: Tab; label: string }[] = [
    { key: 'journey',       label: 'Journey' },
    { key: 'profitability', label: 'Profitability' },
    { key: 'directory',     label: 'Directory' },
    { key: 'fleet',         label: 'Fleet' },
  ];
  return (
    <div className={styles.customersTabs}>
      {tabs.map(t => (
        <button
          key={t.key}
          className={`${styles.customersTab} ${tab === t.key ? styles.customersTabActive : ''}`}
          onClick={() => onChange(t.key)}
        >{t.label}</button>
      ))}
    </div>
  );
}
