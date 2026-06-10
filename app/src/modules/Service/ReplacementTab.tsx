import { useMemo, useState } from 'react';
import { useReplacementOrders, type Order } from '../../lib/orders';
import { isReplacementLine } from '../../lib/orders';
import { replacementItemTags, replacementStageTag, type StageTag } from '../../lib/replacementTags';
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
  // Defensive: line_items can come from two paths:
  //   1. The in-app #55 replacement workflow — full schema (qty, cost_*, sku).
  //   2. The Excel backfill (migration 20260605080000) — looser shape:
  //      `{kind:'part',description}` / `{kind:'unit',batch,unit_serial}` /
  //      `{kind:'unit_pending',batch}` (serial not yet assigned).
  // We count both shapes + surface descriptions for part rows so the
  // table reads "1 unit + Hopper" instead of "1 unit + 1 part".
  let parts = 0;
  let units = 0;
  let unitsPending = 0;
  const partDescs: string[] = [];
  for (const li of line_items) {
    const k = (li as { kind?: string }).kind;
    if (k === 'part') {
      parts += isReplacementLine(li) ? li.qty : 1;
      const desc = (li as { description?: string; name?: string }).description
                ?? (li as { name?: string }).name;
      if (desc) partDescs.push(desc);
    } else if (k === 'unit') {
      units += 1;
    } else if (k === 'unit_pending') {
      unitsPending += 1;
    }
  }
  const segs: string[] = [];
  if (units > 0)        segs.push(`${units} unit${units !== 1 ? 's' : ''}`);
  if (unitsPending > 0) segs.push(`${unitsPending} unit${unitsPending !== 1 ? 's' : ''} (pending)`);
  if (partDescs.length > 0) {
    const joined = partDescs.join(', ');
    segs.push(joined.length > 50 ? joined.slice(0, 47) + '…' : joined);
  } else if (parts > 0) {
    segs.push(`${parts} part${parts !== 1 ? 's' : ''}`);
  }
  return segs.join(' + ') || '—';
}

// Filter by the operator-facing item stage (spec 2026-06-08), not the pipeline
// status. Every replacement is a unit (ready→Unit / pending→awaiting batch) or
// parts/consumables.
const STAGE_FILTERS: { key: 'all' | StageTag; label: string }[] = [
  { key: 'all',                label: 'All' },
  { key: 'Unit',               label: 'Unit' },
  { key: 'awaiting batch',     label: 'awaiting batch' },
  { key: 'Parts/Consumables',  label: 'Parts/Consumables' },
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
  const [filter, setFilter] = useState<'all' | StageTag>('all');
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const batchById = useMemo(() => {
    const m = new Map<string, Batch>();
    for (const b of batches) m.set(b.id, b);
    return m;
  }, [batches]);

  // A batch is "pending" (→ stage tag "awaiting batch") when it has no arrived
  // stock yet, e.g. P100X. Unknown batches default to pending so a not-yet-
  // synced future batch never mislabels as a ready Unit. (spec 2026-06-08)
  const pendingBatchIds = useMemo(
    () => new Set(batches.filter(b => b.arrived_at == null).map(b => b.id)),
    [batches],
  );
  const isPendingBatch = (batch: string) =>
    pendingBatchIds.has(batch) || !batchById.has(batch);

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

  const filtered = useMemo(() => {
    if (filter === 'all') return orders;
    return orders.filter(o => {
      const tags = replacementItemTags(o);
      const st = replacementStageTag(o, tags, b => pendingBatchIds.has(b) || !batchById.has(b));
      return st === filter;
    });
  }, [orders, filter, pendingBatchIds, batchById]);

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
        {STAGE_FILTERS.map(s => (
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
              <th>Tracking</th><th>COGS</th><th>Item Type</th><th>Days open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(o => {
              const daysOpen = Math.floor((now - new Date(o.created_at).getTime()) / 86400_000);
              const stage = stageFor(o);
              const batch = o.awaiting_batch_id ? batchById.get(o.awaiting_batch_id) : null;
              const tags = replacementItemTags(o);
              const stageTag = replacementStageTag(o, tags, isPendingBatch);
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
                  <td title={batch?.notes ?? undefined}>
                    <div className={styles.tagRow}>
                      {tags.length > 0
                        ? tags.map(t => <span key={t} className={styles.itemTag}>{t}</span>)
                        : <span className={styles.muted}>{summarize(o.line_items)}</span>}
                    </div>
                  </td>
                  <td>
                    {o.tracking_num
                      ? <span title={o.carrier ?? ''} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                          {o.carrier ? `${o.carrier} · ` : ''}{o.tracking_num}
                        </span>
                      : <span className={styles.muted} title="No tracking yet — still to be shipped">—</span>}
                  </td>
                  <td>${(o.cogs_usd ?? 0).toFixed(2)}</td>
                  <td>
                    {stageTag
                      ? <span className={styles.stageTag} data-stage={stageTag}>{stageTag}</span>
                      : <span className={styles.muted}>{stage}</span>}
                  </td>
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
