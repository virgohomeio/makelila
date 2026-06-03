import { useMemo, useState } from 'react';
import {
  useServiceTickets, useCustomerLifecycle,
  STATUS_META, warrantyState,
  markOnboardingComplete, markOnboardingNoShow, markOnboardingSkipped,
  type ServiceTicket, type CustomerLifecycle,
} from '../../lib/service';
import { useCustomers, type Customer } from '../../lib/customers';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

// View modes — walkthrough #31 asked for an explicit "needs onboarding —
// not yet scheduled" view so Reina can see who to chase. Default to that
// view because it's the actionable cohort; everything else is reference.
type ViewMode = 'not_scheduled' | 'scheduled' | 'all_units';

export function OnboardingTab() {
  const { tickets, loading: ticketsLoading } = useServiceTickets('onboarding');
  const { rows: lifecycle, loading: lcLoading } = useCustomerLifecycle();
  const { customers } = useCustomers();
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  // Build customer-id → customer-name map once so each lifecycle row can
  // resolve its customer cheaply.
  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const notScheduled = useMemo(
    () => lifecycle.filter(l => l.onboarding_status === 'not_scheduled'),
    [lifecycle],
  );
  const scheduled = useMemo(
    () => lifecycle.filter(l => l.onboarding_status === 'scheduled'),
    [lifecycle],
  );

  // Default the view to whichever cohort has actionable rows. "Not scheduled"
  // wins when there's any backlog; otherwise show "Scheduled".
  const [view, setView] = useState<ViewMode>(() =>
    notScheduled.length > 0 ? 'not_scheduled' : 'scheduled',
  );

  const selectedTicket = tickets.find(t => t.id === selectedTicketId) ?? null;

  // ─── KPIs ──────────────────────────────────────────────────────────
  const weekFromNow = Date.now() + 7 * 86400_000;
  const monthAgo = Date.now() - 30 * 86400_000;
  const scheduledThisWeek = tickets.filter(t =>
    t.calendly_event_start && new Date(t.calendly_event_start).getTime() < weekFromNow && t.status !== 'closed'
  ).length;
  const completedThisMonth = lifecycle.filter(l =>
    l.onboarding_status === 'completed' && l.onboarding_completed_at &&
    new Date(l.onboarding_completed_at).getTime() > monthAgo
  ).length;
  const noShows = lifecycle.filter(l => l.onboarding_status === 'no_show').length;
  const avgDaysToOnboard = useMemo(() => {
    const completed = lifecycle.filter(l => l.onboarding_status === 'completed' && l.onboarding_completed_at);
    if (completed.length === 0) return null;
    const totalDays = completed.reduce((sum, l) => {
      const days = (new Date(l.onboarding_completed_at!).getTime() - new Date(l.shipped_at).getTime()) / 86400_000;
      return sum + days;
    }, 0);
    return Math.round(totalDays / completed.length);
  }, [lifecycle]);

  if (ticketsLoading || lcLoading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Scheduled (7d)"     value={scheduledThisWeek} />
        <Kpi label="Completed (30d)"    value={completedThisMonth} />
        <Kpi label="No-shows"           value={noShows} />
        <Kpi label="Avg ship → onboard" value={avgDaysToOnboard !== null ? `${avgDaysToOnboard}d` : '—'} />
      </div>

      <div className={styles.filterRow}>
        <button
          className={`${styles.chip} ${view === 'not_scheduled' ? styles.chipActive : ''}`}
          onClick={() => setView('not_scheduled')}
          title="Shipped units whose customer hasn't booked an onboarding call yet"
        >
          Not yet scheduled
          {notScheduled.length > 0 && <span className={styles.chipBadge}>{notScheduled.length}</span>}
        </button>
        <button
          className={`${styles.chip} ${view === 'scheduled' ? styles.chipActive : ''}`}
          onClick={() => setView('scheduled')}
          title="Customers with a booked Calendly onboarding session"
        >
          Scheduled
          {scheduled.length > 0 && <span className={styles.chipBadge}>{scheduled.length}</span>}
        </button>
        <button
          className={`${styles.chip} ${view === 'all_units' ? styles.chipActive : ''}`}
          onClick={() => setView('all_units')}
        >All units ({lifecycle.length})</button>
      </div>

      {view === 'not_scheduled' && (
        <NotScheduledView rows={notScheduled} customerById={customerById} />
      )}

      {view === 'scheduled' && (
        <ScheduledView
          tickets={tickets}
          scheduledLifecycle={scheduled}
          customerById={customerById}
          selectedId={selectedTicketId}
          onSelect={setSelectedTicketId}
        />
      )}

      {view === 'all_units' && (
        <AllUnitsView rows={lifecycle} customerById={customerById} />
      )}

      {selectedTicket && <TicketDetailPanel ticket={selectedTicket} onClose={() => setSelectedTicketId(null)} />}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Helper: inline action row (walkthrough #33 — a "Mark complete" button
// on the row itself, no need to open the ticket panel just to disposition).
// ───────────────────────────────────────────────────────────────────────
function LifecycleActions({ row }: { row: CustomerLifecycle }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <button
        className={styles.btnGhost}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); void run(() => markOnboardingComplete(row.id)); }}
      >Mark complete</button>
      {row.onboarding_status === 'scheduled' && (
        <button
          className={styles.btnGhost}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); void run(() => markOnboardingNoShow(row.id)); }}
        >No-show</button>
      )}
      {row.onboarding_status === 'not_scheduled' && (
        <button
          className={styles.btnGhost}
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); void run(() => markOnboardingSkipped(row.id)); }}
          title="Customer opted out of onboarding"
        >Skip</button>
      )}
      {err && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{err}</span>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Views
// ───────────────────────────────────────────────────────────────────────
function NotScheduledView({ rows, customerById }: {
  rows: CustomerLifecycle[];
  customerById: Map<string, Customer>;
}) {
  if (rows.length === 0) {
    return <div className={styles.empty}>Nobody waiting — every shipped customer has been scheduled, completed, or skipped.</div>;
  }
  // Oldest shipments first — those have been waiting longest.
  const sorted = [...rows].sort((a, b) => new Date(a.shipped_at).getTime() - new Date(b.shipped_at).getTime());
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Shipped</th>
          <th>Days since</th>
          <th>Customer</th>
          <th>Unit serial</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(l => {
          const c = l.customer_id ? customerById.get(l.customer_id) : null;
          const daysSince = Math.floor((Date.now() - new Date(l.shipped_at).getTime()) / 86400_000);
          return (
            <tr key={l.id}>
              <td>{new Date(l.shipped_at).toLocaleDateString()}</td>
              <td>{daysSince}d</td>
              <td>
                <div>{c?.full_name ?? <span className={styles.muted}>— no customer linked —</span>}</div>
                {c && <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>{c.email ?? c.phone ?? ''}</div>}
              </td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{l.unit_serial}</td>
              <td><LifecycleActions row={l} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ScheduledView({
  tickets, scheduledLifecycle, customerById, selectedId, onSelect,
}: {
  tickets: ServiceTicket[];
  scheduledLifecycle: CustomerLifecycle[];
  customerById: Map<string, Customer>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Build a serial → lifecycle map so we can attach Mark complete / No-show
  // buttons to the row inline (walkthrough #33).
  const lifecycleBySerial = useMemo(() => {
    const m = new Map<string, CustomerLifecycle>();
    for (const l of scheduledLifecycle) m.set(l.unit_serial, l);
    return m;
  }, [scheduledLifecycle]);

  if (tickets.length === 0) {
    return <div className={styles.empty}>No upcoming onboarding sessions booked.</div>;
  }
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>Customer</th>
          <th>Unit serial</th>
          <th>Host</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map(t => {
          const s = STATUS_META[t.status];
          const lc = t.unit_serial ? lifecycleBySerial.get(t.unit_serial) : null;
          const c = t.customer_id ? customerById.get(t.customer_id) : null;
          const customerLabel = t.customer_name ?? c?.full_name ?? t.customer_email ?? '—';
          return (
            <tr
              key={t.id}
              className={`${styles.row} ${selectedId === t.id ? styles.rowSelected : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <td>{t.calendly_event_start ? new Date(t.calendly_event_start).toLocaleString() : '—'}</td>
              <td>{customerLabel}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{t.unit_serial ?? '—'}</td>
              <td>{t.calendly_host_email ?? '—'}</td>
              <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
              <td>{lc ? <LifecycleActions row={lc} /> : <span className={styles.muted}>—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AllUnitsView({ rows, customerById }: {
  rows: CustomerLifecycle[];
  customerById: Map<string, Customer>;
}) {
  if (rows.length === 0) return <div className={styles.empty}>No shipped units yet.</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Shipped</th>
          <th>Customer</th>
          <th>Unit</th>
          <th>Onboarding</th>
          <th>Warranty</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(l => {
          const w = warrantyState(l);
          const c = l.customer_id ? customerById.get(l.customer_id) : null;
          return (
            <tr key={l.id}>
              <td>{new Date(l.shipped_at).toLocaleDateString()}</td>
              <td>{c?.full_name ?? <span className={styles.muted}>—</span>}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{l.unit_serial}</td>
              <td>{l.onboarding_status}</td>
              <td>
                <span
                  className={`${styles.warrantyPill} ${
                    w.state === 'active'  ? styles.warrantyActive :
                    w.state === 'expired' ? styles.warrantyExpired : styles.warrantyNa
                  }`}
                >
                  {w.state === 'active'  && `${w.daysFromNow}d left`}
                  {w.state === 'expired' && `Expired ${Math.abs(w.daysFromNow)}d ago`}
                  {w.state === 'na'      && 'N/A'}
                </span>
              </td>
              <td>
                {l.onboarding_status !== 'completed' && <LifecycleActions row={l} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}
