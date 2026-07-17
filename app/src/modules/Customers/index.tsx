import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { isTelemetryConfigured } from '../../lib/supabaseTelemetry';
const Dashboard = lazy(() => import('../Dashboard'));
import {
  useCustomers, syncCustomersFromHubspot, exportPurchasers, pushToKlaviyo,
  type Customer,
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
import { useCustomerInvoices, getInvoiceSignedUrl } from '../../lib/invoices';
import styles from './Customers.module.css';

type Tab = 'directory' | 'profitability' | 'journey' | 'fleet';

const TAB_KEYS: Tab[] = ['directory', 'profitability', 'journey', 'fleet'];

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
  const { customers, loading } = useCustomers();
  const { units } = useUnits();
  // Pre-build serial lookups so each row can render its serial(s) without
  // re-filtering the full units list. The canonical units.customer_id FK
  // (populated by the fulfillment-sheet sync, same link the Dashboard uses)
  // is preferred; the lowercase-name map is a fallback for any unit not yet
  // FK-linked.
  const serialsByCustomerId = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units) {
      if (!u.customer_id) continue;
      const arr = m.get(u.customer_id);
      if (arr) arr.push(u.serial);
      else m.set(u.customer_id, [u.serial]);
    }
    return m;
  }, [units]);
  const serialsByCustomerName = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units) {
      if (u.customer_id || !u.customer_name) continue;
      const key = u.customer_name.toLowerCase();
      const arr = m.get(key);
      if (arr) arr.push(u.serial);
      else m.set(key, [u.serial]);
    }
    return m;
  }, [units]);
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
    }).sort((a, b) => a.full_name.localeCompare(b.full_name));
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
              <th>Serial(s)</th>
              <th>Address</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <CustomerRow
                key={c.id}
                c={c}
                serials={
                  // Sheet is the source of truth: prefer the synced serials,
                  // then the canonical units.customer_id link, and only fall
                  // back to name-matching for units not yet FK-linked.
                  (c.serials && c.serials.length > 0)
                    ? c.serials
                    : (serialsByCustomerId.get(c.id)
                        ?? serialsByCustomerName.get(c.full_name?.toLowerCase() ?? '')
                        ?? [])
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
        onClose={() => setSelectedCustomerId(null)}
      />
    )}
    </>
  );
}

function CustomerRow({ c, serials, onSelect }: { c: Customer; serials: string[]; onSelect: () => void }) {
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
      <td><strong>{c.full_name || <span className={styles.muted}>—</span>}</strong></td>
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

function CustomerDetailPanel({ customer, onClose }: { customer: Customer; onClose: () => void }) {
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

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.sectionBody}>{children}</div>
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
    try {
      const url = await getInvoiceSignedUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch (e) { alert((e as Error).message); }
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
