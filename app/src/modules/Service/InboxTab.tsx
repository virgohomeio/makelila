import { useState } from 'react';
import {
  useInbox, setInboxDisposition, SOURCE_LABEL, slaChip,
  type InboxDisposition, type ServiceTicket,
} from '../../lib/service';
import { useIsMobile } from '../../lib/useMediaQuery';
import { NavCard } from '../../components/NavCard';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import { PromoteToTicketModal } from './PromoteToTicketModal';
import styles from './Service.module.css';

type DispositionFilter = 'all' | 'untriaged' | InboxDisposition;

type InboxSourceFilter = 'all_sources' | 'telemetry_auto';

const FILTERS: { key: DispositionFilter; label: string }[] = [
  { key: 'untriaged', label: 'Untriaged' },
  { key: 'all',       label: 'All' },
  { key: 'sales',     label: 'Sales' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'dismissed', label: 'Dismissed' },
];

const SOURCE_FILTERS: { key: InboxSourceFilter; label: string }[] = [
  { key: 'all_sources',    label: 'Any source' },
  { key: 'telemetry_auto', label: 'Telemetry-auto' },
];

function channelIcon(source: ServiceTicket['source']): string {
  if (source === 'quo') return '☎';
  if (source === 'gmail') return '✉';
  if (source === 'telemetry_auto') return '⚡';
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
  const [sourceFilter, setSourceFilter] = useState<InboxSourceFilter>('all_sources');
  const { rows: allRows, loading } = useInbox(filter);
  const rows = sourceFilter === 'telemetry_auto'
    ? allRows.filter(r => r.source === 'telemetry_auto')
    : allRows;
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [openId, setOpenId] = useState<string | null>(null);

  async function handleDisposition(id: string, d: InboxDisposition) {
    setError(null);
    try { await setInboxDisposition(id, d); }
    catch (e) { setError((e as Error).message); }
  }

  // Mobile detail view — shows full message body + actions in a sticky
  // bottom bar so an operator can read + triage without scrolling.
  if (isMobile && openId) {
    const r = rows.find(x => x.id === openId);
    if (!r) { setOpenId(null); return null; }
    return (
      <>
        <MobileBackHeader
          label={r.customer_name ?? r.customer_phone ?? r.customer_email ?? 'Unknown'}
          onBack={() => setOpenId(null)}
        />
        <div style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--color-ink-subtle)' }}>
            {SOURCE_LABEL[r.source]} · {relativeAge(r.last_message_at)} ago · {r.inbox_disposition ?? 'untriaged'}
          </div>
          {r.subject && (
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-ink)' }}>
              {r.subject}
            </div>
          )}
          {r.customer_phone && (
            <div style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--color-ink-subtle)' }}>Phone: </span>
              <a href={`tel:${r.customer_phone}`} style={{ color: 'var(--color-crimson)', fontWeight: 600 }}>{r.customer_phone}</a>
            </div>
          )}
          {r.customer_email && (
            <div style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--color-ink-subtle)' }}>Email: </span>
              <a href={`mailto:${r.customer_email}`} style={{ color: 'var(--color-crimson)', fontWeight: 600 }}>{r.customer_email}</a>
            </div>
          )}
          <div style={{
            background: '#fff', border: '1px solid var(--color-border)', borderRadius: 8,
            padding: 12, fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap',
            color: 'var(--color-ink)',
          }}>
            {r.description ?? 'No body.'}
          </div>
        </div>
        {/* Sticky bottom action bar — sits above the iOS home indicator
            via env(safe-area-inset-bottom). */}
        <div style={{
          position: 'sticky', bottom: 0,
          paddingTop: 10,
          paddingBottom: `max(10px, env(safe-area-inset-bottom))`,
          background: '#fff', borderTop: '1px solid var(--color-border)',
          marginTop: 16, marginLeft: -18, marginRight: -18,
          paddingLeft: 12, paddingRight: 12,
          display: 'flex', gap: 6, flexWrap: 'wrap',
        }}>
          <button
            onClick={() => { setPromoteId(r.id); setOpenId(null); }}
            style={{ flex: '1 1 100%', minHeight: 44, fontWeight: 700,
              background: 'var(--color-crimson)', color: '#fff', border: 'none',
              borderRadius: 6, cursor: 'pointer', fontSize: 13,
            }}
          >→ Promote to Ticket</button>
          <button onClick={() => void handleDisposition(r.id, 'sales')}     style={mobileBtnStyle}>Sales</button>
          <button onClick={() => void handleDisposition(r.id, 'follow_up')} style={mobileBtnStyle}>Follow-up</button>
          <button onClick={() => void handleDisposition(r.id, 'dismissed')} style={mobileBtnStyle}>Dismiss</button>
        </div>
        {promoteId && (
          <PromoteToTicketModal
            conversationId={promoteId}
            onClose={() => setPromoteId(null)}
          />
        )}
      </>
    );
  }

  // Mobile list view — each conversation becomes a NavCard. Filter chips
  // remain at the top so the operator can switch dispositions without
  // popping back to the tab picker.
  if (isMobile) {
    return (
      <>
        <div className={styles.filterRow} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 4px' }}>
          {rows.map(r => (
            <NavCard
              key={r.id}
              onClick={() => setOpenId(r.id)}
              title={r.customer_name ?? r.customer_phone ?? r.customer_email ?? 'Unknown'}
              subtitle={
                (r.subject ? r.subject + ' · ' : '') +
                (r.description ? r.description.slice(0, 60) : 'no body') +
                ' · ' + relativeAge(r.last_message_at)
              }
              icon={channelIcon(r.source)}
              iconBg={r.source === 'quo' ? '#e3f0fb' : r.source === 'gmail' ? '#fef1f0' : '#f5f1eb'}
              count={r.inbox_disposition ?? undefined}
              countTone={r.inbox_disposition ? 'default' : 'default'}
            />
          ))}
        </div>
        {promoteId && (
          <PromoteToTicketModal
            conversationId={promoteId}
            onClose={() => setPromoteId(null)}
          />
        )}
      </>
    );
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
        {SOURCE_FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${sourceFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setSourceFilter(f.key)}
            aria-label={`Source filter: ${f.label}`}
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
              <th>SLA</th>
              <th>Disposition</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const sla = slaChip(r);
              return (
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
                <td>
                  {r.source === 'telemetry_auto'
                    ? <span style={{ background: '#fffaf0', color: '#c05621', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600 }}>Telemetry auto</span>
                    : SOURCE_LABEL[r.source]
                  }
                </td>
                <td><InboxSlaChip label={sla.label} color={sla.color} /></td>
                <td>{r.inbox_disposition ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setPromoteId(r.id)}>→ Ticket</button>
                  <button onClick={() => handleDisposition(r.id, 'sales')}>Sales</button>
                  <button onClick={() => handleDisposition(r.id, 'follow_up')}>Follow-up</button>
                  <button onClick={() => handleDisposition(r.id, 'dismissed')}>Dismiss</button>
                </td>
              </tr>
              );
            })}
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

const mobileBtnStyle: React.CSSProperties = {
  flex: 1, minHeight: 44, fontSize: 12, fontWeight: 700,
  border: '1px solid var(--color-border)', background: '#fff',
  color: 'var(--color-ink)', borderRadius: 6, cursor: 'pointer',
};

const INBOX_SLA_STYLE: Record<string, React.CSSProperties> = {
  green: { background: '#f0fff4', color: '#276749', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600 },
  amber: { background: '#fffaf0', color: '#c05621', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600 },
  red:   { background: '#fff5f5', color: '#c53030', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600 },
  grey:  { background: '#edf2f7', color: '#718096', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 600 },
};

function InboxSlaChip({ label, color }: { label: string; color: 'green' | 'amber' | 'red' | 'grey' }) {
  return <span style={INBOX_SLA_STYLE[color]}>{label}</span>;
}
