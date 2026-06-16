import { useEffect, useMemo, useState } from 'react';
import {
  useServiceTickets, createTicket, syncGmailTickets,
  STATUS_META, TICKET_STATUSES, TOPIC_LABEL,
  statusMeta, priorityMeta, sourceLabel, topicLabel, slaChip,
  ISSUE_AREAS, ISSUE_AREA_LABEL,
  type TicketStatus, type TicketPriority, type TicketTopic, type ServiceTicket,
  type IssueArea,
} from '../../lib/service';
import { useCustomers, syncCustomersFromHubspot, type Customer } from '../../lib/customers';
import { useUnits } from '../../lib/stock';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const STATUS_FILTERS: { key: TicketStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  ...TICKET_STATUSES.map(s => ({ key: s, label: STATUS_META[s].label })),
];

export function SupportTab() {
  const { tickets, loading } = useServiceTickets('support');
  const { customers } = useCustomers();
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot' | 'gmail' | 'quo' | 'telemetry_auto'>('all');
  const [topicFilter, setTopicFilter] = useState<TicketTopic | 'all'>('all');
  const [areaFilter, setAreaFilter] = useState<IssueArea | 'all' | 'none'>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (topicFilter !== 'all' && t.topic !== topicFilter) return false;
      if (areaFilter === 'none' && t.issue_area !== null) return false;
      if (areaFilter !== 'all' && areaFilter !== 'none' && t.issue_area !== areaFilter) return false;
      if (q) {
        const needle = q.toLowerCase();
        return (
          t.subject.toLowerCase().includes(needle) ||
          (t.customer_name ?? '').toLowerCase().includes(needle) ||
          (t.customer_email ?? '').toLowerCase().includes(needle) ||
          (t.summary ?? '').toLowerCase().includes(needle) ||
          t.ticket_number.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [tickets, statusFilter, sourceFilter, topicFilter, areaFilter, q]);

  // Volume per issue area, computed over the *unfiltered* support-ticket
  // pool so the chip counts don't shift when other filters narrow the view.
  const areaCounts = useMemo(() => {
    const counts: Partial<Record<IssueArea, number>> = {};
    let untagged = 0;
    for (const t of tickets) {
      if (t.issue_area && ISSUE_AREAS.includes(t.issue_area)) {
        counts[t.issue_area] = (counts[t.issue_area] ?? 0) + 1;
      } else {
        untagged++;
      }
    }
    return { counts, untagged };
  }, [tickets]);

  const onSyncNow = async () => {
    setSyncing(true); setSyncMessage(null);
    try {
      const r = await syncGmailTickets() as { ok?: boolean; skipped?: boolean; results?: { mailbox: string; threads_processed: number }[] };
      if (r?.skipped) {
        setSyncMessage('Gmail sync not yet configured.');
      } else if (r?.results) {
        const total = r.results.reduce((n, x) => n + (x.threads_processed ?? 0), 0);
        setSyncMessage(`Synced ${total} thread${total === 1 ? '' : 's'} across ${r.results.length} mailbox${r.results.length === 1 ? '' : 'es'}.`);
      } else {
        setSyncMessage('Synced.');
      }
    } catch (e) {
      setSyncMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const selected = filtered.find(t => t.id === selectedId) ?? tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const dayAgo = Date.now() - 86400_000;
  const weekAgo = Date.now() - 7 * 86400_000;
  // Open = anything not yet closed (the only terminal status).
  const openCount = tickets.filter(t => t.status !== 'closed').length;
  const newTodayCount = tickets.filter(t => new Date(t.created_at).getTime() > dayAgo).length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const waitingCount = tickets.filter(t => t.status === 'waiting_on_us').length;
  const closedWeekCount = tickets.filter(t =>
    t.status === 'closed' && t.closed_at && new Date(t.closed_at).getTime() > weekAgo
  ).length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Open"           value={openCount} />
        <Kpi label="New (24h)"      value={newTodayCount} />
        <Kpi label="In progress"    value={inProgressCount} />
        <Kpi label="Waiting on us"  value={waitingCount} />
        <Kpi label="Closed (7d)"    value={closedWeekCount} />
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
          className={`${styles.chip} ${sourceFilter === 'gmail' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('gmail')}
        >Gmail</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'customer_form' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('customer_form')}
        >Form</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'hubspot' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('hubspot')}
        >HubSpot</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'telemetry_auto' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('telemetry_auto')}
        >Telemetry-auto</button>
        <input
          className={styles.search}
          placeholder="Search ticket #, subject, customer, summary…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <button
          className={styles.addBtn}
          onClick={() => void onSyncNow()}
          disabled={syncing}
          title="Manually trigger the Gmail sync edge function"
        >{syncing ? 'Syncing…' : 'Sync now'}</button>
        <button className={styles.addBtn} onClick={() => setShowNew(true)}>
          + Add ticket
        </button>
      </div>

      <div className={styles.filterRow}>
        <span className={styles.filterGroupLabel}>Topic:</span>
        <button
          className={`${styles.chipSm} ${topicFilter === 'all' ? styles.chipActive : ''}`}
          onClick={() => setTopicFilter('all')}
        >Any</button>
        {(Object.keys(TOPIC_LABEL) as TicketTopic[]).map(k => (
          <button
            key={k}
            className={`${styles.chipSm} ${topicFilter === k ? styles.chipActive : ''}`}
            onClick={() => setTopicFilter(k)}
          >{TOPIC_LABEL[k]}</button>
        ))}
      </div>

      <div className={styles.filterRow}>
        <span className={styles.filterGroupLabel}>Issue area:</span>
        <button
          className={`${styles.chipSm} ${areaFilter === 'all' ? styles.chipActive : ''}`}
          onClick={() => setAreaFilter('all')}
        >Any</button>
        {ISSUE_AREAS.map(a => (
          <button
            key={a}
            className={`${styles.chipSm} ${areaFilter === a ? styles.chipActive : ''}`}
            onClick={() => setAreaFilter(a)}
          >
            {ISSUE_AREA_LABEL[a]}
            {(areaCounts.counts[a] ?? 0) > 0 && (
              <span className={styles.chipBadge}>{areaCounts.counts[a]}</span>
            )}
          </button>
        ))}
        <button
          className={`${styles.chipSm} ${areaFilter === 'none' ? styles.chipActive : ''}`}
          onClick={() => setAreaFilter('none')}
          title="Tickets with no issue area set yet"
        >
          Uncategorized
          {areaCounts.untagged > 0 && (
            <span className={styles.chipBadge}>{areaCounts.untagged}</span>
          )}
        </button>
      </div>

      {syncMessage && <div className={styles.syncMessage}>{syncMessage}</div>}

      {filtered.length === 0 ? (
        <div className={styles.empty}>No tickets match these filters.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Age</th>
              <th>Created</th>
              <th>Customer</th>
              <th>Subject</th>
              <th>Topic</th>
              <th>Source</th>
              <th>Priority</th>
              <th>SLA</th>
              <th>Status</th>
              <th>Owner</th>
              <th></th>
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
  const { units } = useUnits();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  // Walkthrough #34: when no candidates match the search, operators
  // suspected the HubSpot sync was stale. Inline this re-sync so they
  // can recover mid-call instead of switching tabs.
  async function handleResync() {
    setResyncing(true); setResyncMsg(null);
    try {
      const r = await syncCustomersFromHubspot();
      setResyncMsg(`Synced ${r.upserted} new customer${r.upserted === 1 ? '' : 's'} from HubSpot. Try the search again.`);
    } catch (e) {
      setResyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResyncing(false);
    }
  }
  const [unitSerial, setUnitSerial] = useState('');
  const [serialAutoFilled, setSerialAutoFilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-populate the unit serial when a customer is picked (walkthrough #36).
  // Match on lowercased customer_name; if the customer has multiple shipped
  // units we pick the most-recent and tag the field with a hint. We only
  // overwrite the serial when (a) the field is empty, or (b) it was
  // previously auto-filled — never when the operator has typed manually.
  useEffect(() => {
    if (!selectedCustomer) return;
    if (unitSerial && !serialAutoFilled) return;
    const lcName = selectedCustomer.full_name.toLowerCase();
    const matches = units
      .filter(u => u.customer_name?.toLowerCase() === lcName)
      .sort((a, b) => (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''));
    if (matches.length === 0) return;
    setUnitSerial(matches[0].serial);
    setSerialAutoFilled(true);
  }, [selectedCustomer, units, unitSerial, serialAutoFilled]);

  const matchedUnitCount = useMemo(() => {
    if (!selectedCustomer) return 0;
    const lcName = selectedCustomer.full_name.toLowerCase();
    return units.filter(u => u.customer_name?.toLowerCase() === lcName).length;
  }, [selectedCustomer, units]);

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
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className={styles.muted} style={{ fontSize: 11 }}>
                      No matching customer. If you just received their message, the HubSpot sync may be a few minutes behind.
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleResync()}
                      disabled={resyncing}
                      className={styles.modalSecondary}
                      style={{ alignSelf: 'flex-start' }}
                    >{resyncing ? 'Re-syncing…' : 'Re-sync from HubSpot'}</button>
                    {resyncMsg && (
                      <span className={styles.muted} style={{ fontSize: 11 }}>{resyncMsg}</span>
                    )}
                  </div>
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
                onChange={e => { setUnitSerial(e.target.value); setSerialAutoFilled(false); }}
                placeholder="LL01-… (optional)"
              />
              {serialAutoFilled && matchedUnitCount > 0 && (
                <span className={styles.muted} style={{ fontSize: 10, marginTop: 2 }}>
                  Auto-filled from {selectedCustomer?.full_name}'s {matchedUnitCount === 1 ? 'shipped unit' : `most recent of ${matchedUnitCount} shipped units`} — edit to override.
                </span>
              )}
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
  const s = statusMeta(t.status);
  const p = priorityMeta(t.priority);
  const sla = slaChip(t);
  // Age: prefer last_message_at (gmail-aware) then created_at.
  const lastTs = t.last_message_at ?? t.created_at;
  const ageHours = (Date.now() - new Date(lastTs).getTime()) / 3_600_000;
  const stale =
    (t.priority === 'urgent' && ageHours > 24) ||
    (t.priority === 'high'   && ageHours > 48);
  const gmailLink = t.gmail_thread_id
    ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(t.gmail_account ?? '')}#all/${t.gmail_thread_id}`
    : null;
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
      title={t.suggested_next_action ?? undefined}
    >
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>
        <span className={stale ? styles.ageStale : styles.age}>
          {stale && <span aria-label="stale" title="Stale">⚠ </span>}
          {formatAge(ageHours)}
        </span>
      </td>
      <td title={new Date(t.created_at).toLocaleString()}>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td>
        <div>{t.subject}</div>
        {t.summary && <div className={styles.rowSummary}>{t.summary}</div>}
        {t.engineering_resolved_at && !t.closed_at && (
          <div
            title={`Engineering resolved ${new Date(t.engineering_resolved_at).toLocaleString()}`}
            style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: '#276749' }}
          >
            Engineering fixed — follow up
          </div>
        )}
      </td>
      <td>{t.topic ? <span className={styles.topicPill}>{topicLabel(t.topic)}</span> : '—'}</td>
      <td>
        {t.source === 'telemetry_auto'
          ? <span className={styles.telemetryAutoBadge}>Telemetry auto</span>
          : sourceLabel(t.source)
        }
      </td>
      <td><span className={styles.pill} style={{ background: '#f7fafc', color: p.color }}>{p.label}</span></td>
      <td><SlaChipPill label={sla.label} color={sla.color} /></td>
      <td>
        <span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span>
        {t.status === 'closed' && t.closed_at && (
          <div className={styles.closedDate}>Closed {new Date(t.closed_at).toLocaleDateString()}</div>
        )}
      </td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
      <td onClick={e => e.stopPropagation()}>
        {gmailLink && (
          <a className={styles.gmailLink} href={gmailLink} target="_blank" rel="noreferrer" title="Open in Gmail">↗</a>
        )}
      </td>
    </tr>
  );
}

const SLA_CHIP_STYLE: Record<string, { background: string; color: string }> = {
  green: { background: '#f0fff4', color: '#276749' },
  amber: { background: '#fffaf0', color: '#c05621' },
  red:   { background: '#fff5f5', color: '#c53030' },
  grey:  { background: '#edf2f7', color: '#718096' },
};

function SlaChipPill({ label, color }: { label: string; color: 'green' | 'amber' | 'red' | 'grey' }) {
  const style = SLA_CHIP_STYLE[color];
  return <span className={styles.pill} style={style}>{label}</span>;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(0, Math.floor(hours * 60))}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}
