import { useMemo, useState } from 'react';
import {
  useServiceTickets, useCustomerLifecycle,
  STATUS_META, warrantyState,
  markOnboardingComplete, markOnboardingNoShow,
  type ServiceTicket,
} from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

export function OnboardingTab() {
  const { tickets, loading } = useServiceTickets('onboarding');
  const { rows: lifecycle, loading: lcLoading } = useCustomerLifecycle();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'tickets' | 'lifecycle'>('tickets');

  const selected = tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
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

  if (loading || lcLoading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Scheduled (7d)"  value={scheduledThisWeek} />
        <Kpi label="Completed (30d)" value={completedThisMonth} />
        <Kpi label="No-shows"        value={noShows} />
        <Kpi label="Avg ship → onboard" value={avgDaysToOnboard !== null ? `${avgDaysToOnboard}d` : '—'} />
      </div>

      <div className={styles.filterRow}>
        <button
          className={`${styles.chip} ${view === 'tickets' ? styles.chipActive : ''}`}
          onClick={() => setView('tickets')}
        >Onboarding calls ({tickets.length})</button>
        <button
          className={`${styles.chip} ${view === 'lifecycle' ? styles.chipActive : ''}`}
          onClick={() => setView('lifecycle')}
        >All shipped units ({lifecycle.length})</button>
      </div>

      {view === 'tickets' ? (
        <TicketsView tickets={tickets} selectedId={selectedId} onSelect={setSelectedId} />
      ) : (
        <LifecycleView />
      )}

      {selected && <TicketDetailPanel ticket={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function TicketsView({ tickets, selectedId, onSelect }: {
  tickets: ServiceTicket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (tickets.length === 0) return <div className={styles.empty}>No onboarding calls scheduled.</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>Customer</th>
          <th>Unit serial</th>
          <th>Host</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map(t => {
          const s = STATUS_META[t.status];
          return (
            <tr
              key={t.id}
              className={`${styles.row} ${selectedId === t.id ? styles.rowSelected : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <td>{t.calendly_event_start ? new Date(t.calendly_event_start).toLocaleString() : '—'}</td>
              <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{t.unit_serial ?? '—'}</td>
              <td>{t.calendly_host_email ?? '—'}</td>
              <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LifecycleView() {
  const { rows } = useCustomerLifecycle();
  const [busy, setBusy] = useState<string | null>(null);

  async function complete(id: string) {
    setBusy(id);
    try { await markOnboardingComplete(id); } finally { setBusy(null); }
  }
  async function noShow(id: string) {
    setBusy(id);
    try { await markOnboardingNoShow(id); } finally { setBusy(null); }
  }

  if (rows.length === 0) return <div className={styles.empty}>No shipped units yet.</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Shipped</th>
          <th>Unit</th>
          <th>Onboarding</th>
          <th>Warranty</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(l => {
          const w = warrantyState(l);
          return (
            <tr key={l.id}>
              <td>{new Date(l.shipped_at).toLocaleDateString()}</td>
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
                {l.onboarding_status !== 'completed' && (
                  <button className={styles.btnGhost} disabled={busy === l.id}
                    onClick={() => void complete(l.id)}>Mark complete</button>
                )}
                {l.onboarding_status === 'scheduled' && (
                  <button className={styles.btnGhost} disabled={busy === l.id}
                    onClick={() => void noShow(l.id)}>No-show</button>
                )}
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
