import { useState } from 'react';
import {
  useInbox, setInboxDisposition, SOURCE_LABEL,
  type InboxDisposition, type ServiceTicket,
} from '../../lib/service';
import { PromoteToTicketModal } from './PromoteToTicketModal';
import styles from './Service.module.css';

type DispositionFilter = 'all' | 'untriaged' | InboxDisposition;

const FILTERS: { key: DispositionFilter; label: string }[] = [
  { key: 'untriaged', label: 'Untriaged' },
  { key: 'all',       label: 'All' },
  { key: 'sales',     label: 'Sales' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'dismissed', label: 'Dismissed' },
];

function channelIcon(source: ServiceTicket['source']): string {
  if (source === 'quo') return '☎';
  if (source === 'gmail') return '✉';
  return '?';
}

function relativeAge(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  return `${d}d`;
}

export function InboxTab() {
  const [filter, setFilter] = useState<DispositionFilter>('untriaged');
  const { rows, loading } = useInbox(filter);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDisposition(id: string, d: InboxDisposition) {
    setError(null);
    try { await setInboxDisposition(id, d); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <div className={styles.filterRow}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${filter === f.key ? styles.chipActive : ''}`}
            onClick={() => setFilter(f.key)}
            aria-label={`Filter: ${f.label}`}
          >{f.label}</button>
        ))}
      </div>

      {error && <div className={styles.syncMessage}>{error}</div>}

      {loading && <div className={styles.empty}>Loading…</div>}
      {!loading && rows.length === 0 && <div className={styles.empty}>Inbox empty.</div>}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ch</th>
              <th>Customer</th>
              <th>Last message</th>
              <th>Age</th>
              <th>Source</th>
              <th>Disposition</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>
                  <span aria-label={SOURCE_LABEL[r.source]} title={SOURCE_LABEL[r.source]}>
                    {channelIcon(r.source)}
                  </span>
                </td>
                <td>{r.customer_name ?? r.customer_phone ?? r.customer_email ?? 'Unknown'}</td>
                <td className={styles.inboxSnippet}>
                  {r.subject && <div className={styles.inboxSubject}>{r.subject}</div>}
                  {r.description && (
                    <div className={styles.inboxPreview}>
                      {r.description.slice(0, 80)}
                    </div>
                  )}
                </td>
                <td>{relativeAge(r.last_message_at)}</td>
                <td>{SOURCE_LABEL[r.source]}</td>
                <td>{r.inbox_disposition ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setPromoteId(r.id)}>→ Ticket</button>
                  <button onClick={() => handleDisposition(r.id, 'sales')}>Sales</button>
                  <button onClick={() => handleDisposition(r.id, 'follow_up')}>Follow-up</button>
                  <button onClick={() => handleDisposition(r.id, 'dismissed')}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {promoteId && (
        <PromoteToTicketModal
          conversationId={promoteId}
          onClose={() => setPromoteId(null)}
        />
      )}
    </>
  );
}
