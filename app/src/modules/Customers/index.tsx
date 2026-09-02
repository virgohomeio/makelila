import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { buildHeldSerialIndex, serialsForCustomer, heldUnitsForCustomer } from '../../lib/heldUnits';
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
import {
  PageHeader, Tabs, Chip, ChipRow, Button, EmptyState,
} from '../../components/ui';
import styles from './Customers.module.css';

type Tab = 'directory' | 'profitability' | 'journey' | 'fleet';

const TAB_KEYS: Tab[] = ['directory', 'profitability', 'journey', 'fleet'];

// Shared empty list for customers with no additional household users — keeps
// the search filter from allocating a new array per row on every keystroke.
const NO_HOUSEHOLD_USERS: CustomerAdditionalUser[] = [];

// Order per operator (2026-06-05): Journey first (default), then
// Profitability, Directory, Fleet. One list now drives the desktop tab strip
// and the mobile picker, which had drifted into two hand-kept copies.
const TABS: { key: Tab; label: string }[] = [
  { key: 'journey',       label: 'Journey' },
  { key: 'profitability', label: 'Profitability' },
  { key: 'directory',     label: 'Directory' },
  { key: 'fleet',         label: 'Fleet' },
];

const MOBILE_TAB_META: Record<Tab, { subtitle: string; icon: string; iconBg: string }> = {
  journey:       { subtitle: '10-stage CJM · health per customer',      icon: '🛤️', iconBg: '#fef1f0' },
  profitability: { subtitle: 'Revenue · returns · margin per customer', icon: '💰', iconBg: '#fff3e0' },
  directory:     { subtitle: 'All customers · search',                  icon: '👥', iconBg: '#e3f0fb' },
  fleet:         { subtitle: 'Live device telemetry · machine health',  icon: '📡', iconBg: '#e3f0fb' },
};

type CountryFilter = 'all' | 'CA' | 'US' | 'other';

const COUNTRY_FILTERS: { key: CountryFilter; label: string; statKey: 'total' | 'ca' | 'us' | 'other' }[] = [
  { key: 'all',   label: 'All',    statKey: 'total' },
  { key: 'CA',    label: 'Canada', statKey: 'ca' },
  { key: 'US',    label: 'US',     statKey: 'us' },
  { key: 'other', label: 'Other',  statKey: 'other' },
];

// The page-load settle, staggered down the three bands of the Directory.
// prefers-reduced-motion removes the animation entirely in the stylesheet, so
// the delay is inert rather than needing to be switched off here.
const revealDelay = (ms: number) => ({ '--reveal-delay': `${ms}ms` } as CSSProperties);

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
  // Serial lookups live in lib/heldUnits so the list row below and the detail
  // panel further down share one definition of "currently held" — they used to
  // each hand-roll it and disagreed about returned machines.
  const serialIndex = useMemo(() => buildHeldSerialIndex(units), [units]);
  const serialsFor = useCallback(
    (c: Customer) => serialsForCustomer(c, serialIndex),
    [serialIndex],
  );
  // Every household user in the directory, so the search box can look past the
  // purchaser's name (the per-customer hook only covers the open panel).
  const { byCustomerId: usersByCustomerId } = useAllCustomerAdditionalUsers();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<CountryFilter>('all');
  // Record gaps are a second, independent axis: 'US customers we cannot
  // email' is a real question and was not askable before.
  const [noEmailOnly, setNoEmailOnly] = useState(false);
  const [noAddressOnly, setNoAddressOnly] = useState(false);
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
      if (noEmailOnly && c.email) continue;
      if (noAddressOnly && (c.city || c.region || c.postal_code)) continue;
      const m = matchCustomerSearch(c, usersByCustomerId.get(c.id) ?? NO_HOUSEHOLD_USERS, search);
      if (!m.matched) continue;
      rows.push({ customer: c, via: m.via });
    }
    return rows.sort((a, b) => a.customer.full_name.localeCompare(b.customer.full_name));
  }, [customers, country, noEmailOnly, noAddressOnly, search, usersByCustomerId]);

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
    return {
      ...s,
      // The tiles report what needs work. 'with email, 90%' is the same
      // fact read from the side that needs none.
      noEmail: s.total - s.withEmail,
      noAddress: s.total - s.withAddress,
      lastSync: lastSync ? new Date(lastSync) : null,
    };
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
      setToast(`Pushed ${r.pushed} profiles to Klaviyo list ${listId.trim()}${r.excluded ? ` (${r.excluded} excluded as refunded)` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Mobile: until a tab is picked, render a NavCard picker for the four
  // sub-views. Tapping a card flips `mobileTabPicked` and the branches below
  // render with a MobileBackHeader in place of the desktop header.
  if (isMobile && !mobileTabPicked) {
    return (
      <div className={styles.layout}>
        <PageHeader title="Customers" meta="Journey, profitability, directory and fleet." />
        <div className={styles.mobilePicker}>
          {TABS.map(t => (
            <NavCard
              key={t.key}
              onClick={() => { setTab(t.key); setMobileTabPicked(true); }}
              title={t.label}
              subtitle={MOBILE_TAB_META[t.key].subtitle}
              icon={MOBILE_TAB_META[t.key].icon}
              iconBg={MOBILE_TAB_META[t.key].iconBg}
            />
          ))}
        </div>
      </div>
    );
  }

  const tabLabel =
    tab === 'journey'       ? 'Journey' :
    tab === 'profitability' ? 'Profitability' :
    tab === 'fleet'         ? 'Fleet' :
                              'Directory';
  const onMobileBack = () => setMobileTabPicked(false);

  // What each tab is, in one line. The Directory's is live because it is the
  // one tab whose contents change as you type.
  const meta =
    tab === 'directory' ? (
      <>
        <strong>{filtered.length}</strong> of <strong>{stats.total}</strong> customers
        {stats.lastSync && (
          <> · synced from HubSpot{' '}
            <strong>{stats.lastSync.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</strong>
          </>
        )}
      </>
    ) : tab === 'journey' ? 'Where every customer sits in the ten-stage journey, and how they are doing.'
      : tab === 'profitability' ? 'Revenue, returns and margin, per customer.'
      : 'Live telemetry from machines in the field.';

  // One header for all four tabs. Each branch used to declare its own title
  // row, which is how the Directory's tab strip drifted a different colour
  // from everything else in the app without anyone noticing.
  const header = isMobile ? (
    <MobileBackHeader label={tabLabel} onBack={onMobileBack} />
  ) : (
    <>
      <PageHeader
        title="Customers"
        meta={meta}
        actions={tab === 'directory' ? (
          <>
            <ExportMenu busy={busy} onExport={handleExport} onKlaviyo={handleKlaviyoPush} />
            <Button variant="primary" onClick={handleSync} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync from HubSpot'}
            </Button>
          </>
        ) : undefined}
      />
      <Tabs
        ariaLabel="Customers sections"
        items={TABS.map(t => ({ key: t.key, label: t.label }))}
        active={tab}
        onChange={k => setTab(k as Tab)}
      />
    </>
  );

  if (tab === 'fleet') {
    if (!isTelemetryConfigured) {
      return (
        <div className={styles.layout}>
          {header}
          <EmptyState
            title="Telemetry is not configured"
            body="Set VITE_TELEMETRY_SUPABASE_URL and VITE_TELEMETRY_SUPABASE_ANON_KEY in .env, then reload."
          />
        </div>
      );
    }
    return (
      <div className={styles.layout}>
        {header}
        <RouteErrorBoundary label="Fleet">
          <Suspense fallback={<div className={styles.loading}>Loading fleet…</div>}>
            <Dashboard />
          </Suspense>
        </RouteErrorBoundary>
      </div>
    );
  }

  if (tab === 'profitability') {
    return <div className={styles.layout}>{header}<ProfitabilityTab /></div>;
  }

  if (tab === 'journey') {
    return <div className={styles.layout}>{header}<JourneyTab /></div>;
  }

  const filtersOn = country !== 'all' || noEmailOnly || noAddressOnly || search.trim() !== '';
  const clearFilters = () => { setCountry('all'); setNoEmailOnly(false); setNoAddressOnly(false); setSearch(''); };

  return (
    <>
    <div className={styles.layout}>
      {header}

      {toast && (
        <div className={`${styles.toast} ${styles.toastSuccess}`}>
          <span className={styles.toastText}>{toast}</span>
          <button className={styles.toastClose} onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {error && (
        <div className={`${styles.toast} ${styles.toastError}`}>
          <span className={styles.toastText}>{error}</span>
          <button className={styles.toastClose} onClick={() => setError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* There is deliberately no KPI tile row here. The one this replaced
          reported Total / Canada-US / With email / With address — four figures
          the filter chips below already carry, in a form you can also click.
          The total and the sync time live in the page header. */}
      <div className={`${styles.filterBar} ${styles.reveal}`} style={revealDelay(0)}>
        <div className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="6.2" cy="6.2" r="4.2" />
              <path d="M9.4 9.4 12.5 12.5" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search any name on the record, email, phone, city…"
            aria-label="Search customers"
            className={styles.searchField}
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M1 1l7 7M8 1l-7 7" />
              </svg>
            </button>
          )}
        </div>

        <span className={styles.filterDivider} aria-hidden="true" />

        {/* Country is one axis and record gaps are another, so they are two
            chip groups rather than one row of six that would read as
            mutually exclusive. */}
        <ChipRow>
          {COUNTRY_FILTERS.map(c => (
            <Chip
              key={c.key}
              label={c.label}
              count={stats[c.statKey]}
              active={country === c.key}
              onClick={() => setCountry(c.key)}
            />
          ))}
        </ChipRow>

        <span className={styles.filterDivider} aria-hidden="true" />

        <ChipRow>
          <Chip label="No email" count={stats.noEmail} active={noEmailOnly} onClick={() => setNoEmailOnly(v => !v)} />
          <Chip label="No address" count={stats.noAddress} active={noAddressOnly} onClick={() => setNoAddressOnly(v => !v)} />
        </ChipRow>

        <div className={styles.movedNote}>
          Follow-ups moved to <Link to="/service?tab=followups">Service → Follow-Ups</Link>
        </div>
      </div>

      <div className={`${styles.tableWrap} ${styles.reveal}`} style={revealDelay(60)}>
        {loading ? (
          <DirectorySkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={filtersOn ? 'No customer matches these filters' : 'No customers yet'}
            body={filtersOn
              ? 'Search covers every name on a record — the purchaser, the primary user and anyone else in the household.'
              : 'Customers arrive from HubSpot. Run a sync to bring them in.'}
            action={filtersOn
              ? <Button onClick={clearFilters}>Clear filters</Button>
              : <Button variant="primary" onClick={handleSync} disabled={busy}>Sync from HubSpot</Button>}
          />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Serial</th>
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
                  selected={c.id === selectedCustomerId}
                  serials={serialsFor(c)}
                  onSelect={() => setSelectedCustomerId(c.id)}
                />
              ))}
            </tbody>
          </table>
        )}
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

/* Four bulk-list operations that used to be four header buttons, each as loud
   as Sync. They are reached for once a campaign, not once a shift. */
function ExportMenu({ busy, onExport, onKlaviyo }: {
  busy: boolean;
  onExport: (minusRefunds: boolean) => void;
  onKlaviyo: (minusRefunds: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className={styles.menuWrap} ref={wrap}>
      <Button onClick={() => setOpen(o => !o)} disabled={busy} aria-expanded={open} aria-haspopup="menu">
        Export ▾
      </Button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuLabel}>Download CSV</div>
          <button role="menuitem" className={styles.menuItem} onClick={() => pick(() => onExport(false))}>
            All purchasers
          </button>
          <button role="menuitem" className={styles.menuItem} onClick={() => pick(() => onExport(true))}>
            Purchasers minus refunds
            <span>Leaves out anyone who has been refunded</span>
          </button>
          <div className={styles.menuLabel}>Push to Klaviyo</div>
          <button role="menuitem" className={styles.menuItem} onClick={() => pick(() => onKlaviyo(false))}>
            All purchasers
          </button>
          <button role="menuitem" className={styles.menuItem} onClick={() => pick(() => onKlaviyo(true))}>
            Purchasers minus refunds
            <span>Asks for the Klaviyo list ID first</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* Skeleton rows inside the real table frame. The directory used to replace the
   whole module with one line of centred grey text, so landing on the tab moved
   every control on the page once the rows arrived. */
function DirectorySkeleton() {
  const widths = ['62%', '78%', '54%', '40%', '70%', '46%'];
  return (
    <table className={styles.table} aria-hidden="true">
      <thead>
        <tr><th>Name</th><th>Email</th><th>Phone</th><th>Serial</th><th>Address</th><th>Last sync</th></tr>
      </thead>
      <tbody>
        {Array.from({ length: 9 }, (_, r) => (
          <tr key={r}>
            {widths.map((w, i) => (
              <td key={i}><div className={styles.skelBar} style={{ width: w }} /></td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CustomerRow(
  { c, serials, via, selected, onSelect }:
  { c: Customer; serials: string[]; via: string | null; selected: boolean; onSelect: () => void },
) {
  const cityRegion = [c.city, c.region].filter(Boolean).join(', ');
  const addr = [c.address_line, cityRegion, c.postal_code, c.country].filter(Boolean).join(' · ');
  const dash = <span className={styles.dash}>—</span>;
  return (
    <tr
      onClick={onSelect}
      // A row that opens a panel is a control, so it takes focus and answers
      // to the keyboard like one.
      tabIndex={0}
      aria-selected={selected}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
    >
      <td className={styles.nameCell}>
        <div className={styles.cellName}>{c.full_name || dash}</div>
        {/* Why this row is in the results when the name searched for isn't the
            purchaser's. */}
        {via && <div className={styles.viaMatch}>via {via}</div>}
      </td>
      <td className={styles.cellData} title={c.email ?? undefined}>{c.email ?? dash}</td>
      <td className={styles.cellData}>{c.phone ?? dash}</td>
      <td title={serials.join(', ')}>
        {serials.length === 0 ? dash : (
          <>
            <span className={styles.serialChip}>{serials[0]}</span>
            {serials.length > 1 && <span className={styles.serialMore}>+{serials.length - 1}</span>}
          </>
        )}
      </td>
      <td title={addr}>{addr || dash}</td>
      <td className={styles.cellData}>
        {c.last_synced_at
          ? new Date(c.last_synced_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
          : dash}
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lcEmail = customer.email?.toLowerCase() ?? '';

  const myOrders = lcEmail
    ? orders.filter(o => o.customer_email?.toLowerCase() === lcEmail)
    : [];
  // Same rule as the directory list row — see lib/heldUnits. Panel and row
  // used to disagree: the row hid returned machines while opening the same
  // customer listed them as still held.
  const myUnits = heldUnitsForCustomer(customer, units);
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
          <button onClick={onClose} className={styles.panelClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
            </svg>
          </button>
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
                      <div className={`${styles.orderCardRow} ${styles.orderTotalRow}`}>
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
              className={styles.linkBtn}
            >View</button>
          </div>
        ))
      )}
    </PanelSection>
  );
}
