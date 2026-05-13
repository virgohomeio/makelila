import { useMemo, useState } from 'react';
import { useServiceTickets, STATUS_META, type TicketStatus, type ServiceTicket } from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const STATUS_FILTERS: { key: TicketStatus | 'all'; label: string }[] = [
  { key: 'all',         label: 'All' },
  { key: 'new',         label: 'New' },
  { key: 'triaging',    label: 'Diagnosing' },
  { key: 'in_progress', label: 'In repair' },
  { key: 'waiting_customer', label: 'Waiting parts/customer' },
  { key: 'resolved',    label: 'Resolved' },
];

export function RepairTab() {
  const { tickets, loading } = useServiceTickets('repair');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() =>
    tickets.filter(t => statusFilter === 'all' || t.status === statusFilter),
    [tickets, statusFilter]);
  const selected = tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const openCount = tickets.filter(t => t.status !== 'closed' && t.status !== 'resolved').length;
  const inRepairCount = tickets.filter(t => t.status === 'in_progress').length;
  const monthAgo = Date.now() - 30 * 86400_000;
  const resolvedMonthCount = tickets.filter(t =>
    t.status === 'resolved' && t.resolved_at && new Date(t.resolved_at).getTime() > monthAgo
  ).length;

  const avgRepairDays = useMemo(() => {
    const resolved = tickets.filter(t => t.status === 'resolved' && t.resolved_at);
    if (resolved.length === 0) return null;
    const totalDays = resolved.reduce((sum, t) => {
      const days = (new Date(t.resolved_at!).getTime() - new Date(t.created_at).getTime()) / 86400_000;
      return sum + days;
    }, 0);
    return Math.round(totalDays / resolved.length);
  }, [tickets]);

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Open"          value={openCount} />
        <Kpi label="In repair"     value={inRepairCount} />
        <Kpi label="Resolved (30d)" value={resolvedMonthCount} />
        <Kpi label="Avg repair days" value={avgRepairDays !== null ? `${avgRepairDays}d` : '—'} />
      </div>

      <div className={styles.filterRow}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${statusFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setStatusFilter(f.key)}
          >{f.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No repair tickets match these filters.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Flagged</th>
              <th>Customer</th>
              <th>Unit serial</th>
              <th>Defect</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Days open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <RepairRow key={t.id} t={t}
                selected={selectedId === t.id}
                onClick={() => setSelectedId(t.id)} />
            ))}
          </tbody>
        </table>
      )}

      {selected && <TicketDetailPanel ticket={selected} onClose={() => setSelectedId(null)} />}
    </>
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

function RepairRow({ t, selected, onClick }: { t: ServiceTicket; selected: boolean; onClick: () => void }) {
  const s = STATUS_META[t.status];
  const daysOpen = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400_000);
  return (
    <tr className={`${styles.row} ${selected ? styles.rowSelected : ''}`} onClick={onClick}>
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{t.unit_serial ?? '—'}</td>
      <td>{t.defect_category ?? '—'}</td>
      <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
      <td>{daysOpen}</td>
    </tr>
  );
}
