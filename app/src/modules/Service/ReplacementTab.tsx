import { useMemo, useState } from 'react';
import { useReplacementOrders, type Order } from '../../lib/orders';
import { isReplacementLine } from '../../lib/orders';
import { useBatches, type Batch } from '../../lib/stock';
import { useServiceTickets, type TicketTopic } from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

type Stage = 'pending' | 'approved' | 'fulfilling' | 'shipped' | 'delivered' | 'closed' | 'awaiting_batch';

function stageFor(o: Order): Stage {
  // Backlog #71 — batch-blocked orders surface as their own group so
  // operators can see at a glance which orders are stuck waiting on
  // inbound stock vs. actionable in the normal pipeline.
  if (o.awaiting_batch_id && !o.shipped_at && !o.delivered_at) return 'awaiting_batch';
  if (o.delivered_at) return 'delivered';
  if (o.shipped_at) return 'shipped';
  if (o.status === 'approved') return 'fulfilling';
  return o.status as Stage;
}

function summarize(line_items: Order['line_items']): string {
  let parts = 0, units = 0;
  for (const li of line_items) {
    if (!isReplacementLine(li)) continue;
    if (li.kind === 'part') parts += li.qty;
    if (li.kind === 'unit') units += 1;
  }
  const parts_s = parts === 0 ? '' : `${parts} part${parts !== 1 ? 's' : ''}`;
  const units_s = units === 0 ? '' : `${units} unit${units !== 1 ? 's' : ''}`;
  return [parts_s, units_s].filter(Boolean).join(' + ') || '—';
}

const STAGES: { key: Stage | 'all'; label: string }[] = [
  { key: 'all',             label: 'All' },
  { key: 'pending',         label: 'Pending' },
  { key: 'awaiting_batch',  label: 'Awaiting batch' },
  { key: 'fulfilling',      label: 'Fulfilling' },
  { key: 'shipped',         label: 'Shipped' },
  { key: 'delivered',       label: 'Delivered' },
  { key: 'closed',          label: 'Closed' },
];

// Backlog #41 — topics that signal "this ticket is asking for a replacement"
// and should land in the triage section. The classifier sets these
// automatically (lib/classifier.ts); operators can also flip the topic
// manually on the ticket detail panel.
const TRIAGE_TOPICS: TicketTopic[] = ['return_hardware_defect', 'warranty_replacement'];

// Tickets in these statuses are "done" — exclude from triage.
const CLOSED_TICKET_STATUSES = new Set(['resolved', 'closed']);

export default function ReplacementTab() {
  const { orders, loading } = useReplacementOrders();
  const { batches } = useBatches();
  // Pull every support/repair ticket so we can filter for triage candidates.
  // useServiceTickets() with no arg returns all categories; we filter below.
  const { tickets } = useServiceTickets();
  const [filter, setFilter] = useState<Stage | 'all'>('all');
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const batchById = useMemo(() => {
    const m = new Map<string, Batch>();
    for (const b of batches) m.set(b.id, b);
    return m;
  }, [batches]);

  // Backlog #41 — triage candidates: open service tickets whose topic flags
  // them as a likely replacement, and that don't yet have a replacement
  // order linked. Sorted by oldest-first so longest-waiting tickets surface
  // at the top.
  const triageCandidates = useMemo(() => {
    return tickets
      .filter(t =>
        !t.replacement_order_id
        && t.topic != null
        && TRIAGE_TOPICS.includes(t.topic)
        && !CLOSED_TICKET_STATUSES.has(t.status),
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [tickets]);

  const filtered = useMemo(
    () => orders.filter(o => filter === 'all' || stageFor(o) === filter),
    [orders, filter],
  );

  const openTicket = useMemo(
    () => openTicketId ? tickets.find(t => t.id === openTicketId) ?? null : null,
    [openTicketId, tickets],
  );

  const now = Date.now();
  const monthAgo = now - 30 * 86400_000;
  const open = orders.filter(o => !o.delivered_at).length;
  const awaitingBatch = orders.filter(o => o.awaiting_batch_id && !o.shipped_at && !o.delivered_at).length;
  const shipped30 = orders.filter(o => o.shipped_at && new Date(o.shipped_at).getTime() > monthAgo).length;
  const delivered30 = orders.filter(o => o.delivered_at && new Date(o.delivered_at).getTime() > monthAgo).length;
  const cogs30: number[] = orders
    .filter(o => o.delivered_at && new Date(o.delivered_at).getTime() > monthAgo)
    .map(o => o.cogs_usd ?? 0);
  const avgCogs = cogs30.length === 0 ? null : cogs30.reduce((a, b) => a + b, 0) / cogs30.length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Open</div><div className={styles.kpiValue}>{open}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Triage candidates</div><div className={styles.kpiValue}>{triageCandidates.length}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Awaiting batch</div><div className={styles.kpiValue}>{awaitingBatch}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Shipped (30d)</div><div className={styles.kpiValue}>{shipped30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Delivered (30d)</div><div className={styles.kpiValue}>{delivered30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Avg COGS (30d)</div><div className={styles.kpiValue}>{avgCogs == null ? '—' : `$${avgCogs.toFixed(2)}`}</div></div>
      </div>

      {/* Backlog #41 — Triage candidates from tickets */}
      {triageCandidates.length > 0 && (
        <details open className={styles.triageSection}>
          <summary>
            <strong>Triage candidates from tickets</strong>
            <span className={styles.triageHint}>
              {' '}— defect / warranty tickets without a replacement order yet. Open one and click "Send replacement" on the ticket panel to start an order.
            </span>
          </summary>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticket #</th>
                <th>Customer</th>
                <th>Topic</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Days open</th>
              </tr>
            </thead>
            <tbody>
              {triageCandidates.map(t => {
                const daysOpen = Math.floor((now - new Date(t.created_at).getTime()) / 86400_000);
                return (
                  <tr key={t.id} className={styles.row} onClick={() => setOpenTicketId(t.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
                    <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
                    <td><span className={styles.triageTopic}>{t.topic}</span></td>
                    <td>{t.subject.length > 60 ? t.subject.slice(0, 57) + '…' : t.subject}</td>
                    <td>{t.status}</td>
                    <td>{daysOpen}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}

      <h3 className={styles.sectionHeading}>Replacement orders</h3>

      <div className={styles.filterRow}>
        {STAGES.map(s => (
          <button key={s.key}
            className={`${styles.chip} ${filter === s.key ? styles.chipActive : ''}`}
            onClick={() => setFilter(s.key)}>{s.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No replacement orders.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order #</th><th>Ticket</th><th>Customer</th><th>Items</th>
              <th>COGS</th><th>Stage</th><th>Days open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(o => {
              const daysOpen = Math.floor((now - new Date(o.created_at).getTime()) / 86400_000);
              const stage = stageFor(o);
              const batch = o.awaiting_batch_id ? batchById.get(o.awaiting_batch_id) : null;
              return (
                <tr key={o.id} className={styles.row}>
                  <td><a href="#/order-review">{o.order_ref}</a></td>
                  <td>
                    {o.linked_ticket_id ? (
                      <button
                        type="button"
                        className={styles.linkLike}
                        onClick={() => setOpenTicketId(o.linked_ticket_id)}
                      >open</button>
                    ) : '—'}
                  </td>
                  <td>{o.customer_name}</td>
                  <td>
                    {stage === 'awaiting_batch' ? (
                      <span className={styles.awaitingBatchTag} title={batch?.notes ?? ''}>
                        Awaiting {o.awaiting_batch_id}
                      </span>
                    ) : (
                      summarize(o.line_items)
                    )}
                  </td>
                  <td>${(o.cogs_usd ?? 0).toFixed(2)}</td>
                  <td>{stage === 'awaiting_batch' ? (
                    <span className={styles.awaitingBatchTag}>awaiting batch</span>
                  ) : stage}</td>
                  <td>{daysOpen}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {openTicket && (
        <TicketDetailPanel ticket={openTicket} onClose={() => setOpenTicketId(null)} />
      )}
    </>
  );
}
