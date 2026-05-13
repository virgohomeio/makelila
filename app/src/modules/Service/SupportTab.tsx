import { useMemo, useState } from 'react';
import {
  useServiceTickets, STATUS_META, PRIORITY_META, SOURCE_LABEL,
  type TicketStatus, type ServiceTicket,
} from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const STATUS_FILTERS: { key: TicketStatus | 'all'; label: string }[] = [
  { key: 'all',              label: 'All' },
  { key: 'new',              label: 'New' },
  { key: 'triaging',         label: 'Triaging' },
  { key: 'in_progress',      label: 'In progress' },
  { key: 'waiting_customer', label: 'Waiting customer' },
  { key: 'resolved',         label: 'Resolved' },
];

export function SupportTab() {
  const { tickets, loading } = useServiceTickets('support');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot'>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (q) {
        const needle = q.toLowerCase();
        return (
          t.subject.toLowerCase().includes(needle) ||
          (t.customer_name ?? '').toLowerCase().includes(needle) ||
          (t.customer_email ?? '').toLowerCase().includes(needle) ||
          t.ticket_number.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [tickets, statusFilter, sourceFilter, q]);

  const selected = filtered.find(t => t.id === selectedId) ?? tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const dayAgo = Date.now() - 86400_000;
  const weekAgo = Date.now() - 7 * 86400_000;
  const newTodayCount = tickets.filter(t => new Date(t.created_at).getTime() > dayAgo).length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const waitingCount = tickets.filter(t => t.status === 'waiting_customer').length;
  const resolvedWeekCount = tickets.filter(t =>
    t.status === 'resolved' && t.resolved_at && new Date(t.resolved_at).getTime() > weekAgo
  ).length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="New (24h)"     value={newTodayCount} />
        <Kpi label="In progress"   value={inProgressCount} />
        <Kpi label="Waiting cust." value={waitingCount} />
        <Kpi label="Resolved (7d)" value={resolvedWeekCount} />
      </div>

      <div className={styles.filterRow}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${statusFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setStatusFilter(f.key)}
          >{f.label}</button>
        ))}
        <button
          className={`${styles.chip} ${sourceFilter === 'all' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('all')}
        >Any source</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'customer_form' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('customer_form')}
        >Form</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'hubspot' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('hubspot')}
        >HubSpot</button>
        <input
          className={styles.search}
          placeholder="Search ticket #, subject, customer…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No tickets match these filters.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Created</th>
              <th>Customer</th>
              <th>Subject</th>
              <th>Source</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <TicketRow key={t.id} t={t}
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

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function TicketRow({ t, selected, onClick }: { t: ServiceTicket; selected: boolean; onClick: () => void }) {
  const s = STATUS_META[t.status];
  const p = PRIORITY_META[t.priority];
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
    >
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td>{t.subject}</td>
      <td>{SOURCE_LABEL[t.source]}</td>
      <td><span className={styles.pill} style={{ background: '#f7fafc', color: p.color }}>{p.label}</span></td>
      <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
    </tr>
  );
}
