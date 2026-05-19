import { useMemo, useState } from 'react';
import {
  useServiceTickets, createTicket, STATUS_META, PRIORITY_META, SOURCE_LABEL,
  type TicketStatus, type TicketPriority, type ServiceTicket,
} from '../../lib/service';
import { useCustomers, type Customer } from '../../lib/customers';
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
  const { customers } = useCustomers();
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot'>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

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
        <button className={styles.addBtn} onClick={() => setShowNew(true)}>
          + Add ticket
        </button>
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

      {showNew && (
        <NewTicketModal
          customers={customers}
          onClose={() => setShowNew(false)}
          onCreated={(t) => { setShowNew(false); setSelectedId(t.id); }}
        />
      )}
    </>
  );
}

function NewTicketModal({
  customers, onClose, onCreated,
}: {
  customers: Customer[];
  onClose: () => void;
  onCreated: (t: ServiceTicket) => void;
}) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [unitSerial, setUnitSerial] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    if (!needle) return [];
    return customers.filter(c =>
      c.full_name.toLowerCase().includes(needle) ||
      (c.email ?? '').toLowerCase().includes(needle) ||
      (c.phone ?? '').toLowerCase().includes(needle),
    ).slice(0, 8);
  }, [customers, customerSearch]);

  const canSubmit = subject.trim().length > 0 && selectedCustomer !== null && !submitting;

  const submit = async () => {
    if (!selectedCustomer) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await createTicket({
        category: 'support',
        subject: subject.trim(),
        description: description.trim() || null,
        priority,
        customer_id: selectedCustomer.id,
        customer_name: selectedCustomer.full_name,
        customer_email: selectedCustomer.email,
        customer_phone: selectedCustomer.phone,
        unit_serial: unitSerial.trim() || null,
      });
      onCreated(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>New support ticket</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label>Subject *</label>
            <input
              type="text"
              className={styles.modalInput}
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Short summary of the issue"
              autoFocus
            />
          </div>
          <div className={styles.modalRow}>
            <label>Customer *</label>
            {selectedCustomer ? (
              <div className={styles.modalSelected}>
                <strong>{selectedCustomer.full_name}</strong>
                <span className={styles.muted}>
                  {[selectedCustomer.email, selectedCustomer.phone, selectedCustomer.city]
                    .filter(Boolean).join(' · ') || '—'}
                </span>
                <button
                  className={styles.modalLinkBtn}
                  onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }}
                >change</button>
              </div>
            ) : (
              <div className={styles.modalPicker}>
                <input
                  type="text"
                  className={styles.modalInput}
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                  placeholder="Type a name, email, or phone…"
                />
                {candidates.length > 0 && (
                  <div className={styles.modalDropdown}>
                    {candidates.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedCustomer(c)}
                        className={styles.modalDropItem}
                      >
                        <strong>{c.full_name}</strong>
                        <span className={styles.muted}>
                          {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {customerSearch.trim() && candidates.length === 0 && (
                  <span className={styles.muted} style={{ fontSize: 11, marginTop: 4 }}>
                    No matching customer. Add them in the Customers tab first.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className={styles.modalRow}>
            <label>Description</label>
            <textarea
              className={styles.modalTextarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What happened? Steps the customer took, error messages, etc."
              rows={3}
            />
          </div>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Priority</label>
              <select
                className={styles.modalSelect}
                value={priority}
                onChange={e => setPriority(e.target.value as TicketPriority)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className={styles.modalRow}>
              <label>Unit serial</label>
              <input
                type="text"
                className={styles.modalInput}
                value={unitSerial}
                onChange={e => setUnitSerial(e.target.value)}
                placeholder="LL01-… (optional)"
              />
            </div>
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary}>Cancel</button>
          <button
            onClick={() => void submit()}
            className={styles.modalPrimary}
            disabled={!canSubmit}
          >
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
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
