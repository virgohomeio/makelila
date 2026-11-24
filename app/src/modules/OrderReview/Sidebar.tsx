import { useMemo, useState } from 'react';
import type { Order } from '../../lib/orders';
import { SALES_QUEUE_START } from '../../lib/orders';
import { OrderRow } from './OrderRow';
import { indexRefundFlags, useRefundMarks } from '../../lib/refundedOrders';
import { useOrderCommAssessments } from '../../lib/orderComms';
import { EmptyState } from '../../components/ui';
import styles from './OrderReview.module.css';

type Tab = 'pending' | 'attention' | 'priority' | 'approved' | 'all' | 'cancelled';

export function Sidebar({
  pending, pendingBacklog, held, flagged, priority, approved, all, cancelled,
  selectedId,
  onSelect,
}: {
  pending: Order[];
  /** What Pending holds back because the money already went back. They are not
   *  in that tab but are still in All, so the rail says so rather than letting
   *  them disappear quietly. */
  pendingBacklog: Order[];
  /** Held and Flagged are one tab now — "Needs Attention" — because both mean
   *  the same thing to the operator working the rail: this order is parked and
   *  waiting on a person, not moving through the queue. They stay distinct
   *  statuses underneath (each row still says which), and are passed in
   *  separately so the merge lives here and nowhere else. */
  held: Order[];
  flagged: Order[];
  /** Walmart / Best Buy and hand-pinned orders — a cross-cut over the live
   *  queue, not a status. See OrderBuckets.priority. */
  priority: Order[];
  approved: Order[];
  all: Order[];
  /** Terminal — cancelled here or from the fulfillment queue. Already sorted
   *  newest-cancelled first by bucketOrders. */
  cancelled: Order[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [query, setQuery] = useState('');
  // One query for the whole rail rather than one per row: a refund badge is
  // cheap to compute and expensive to fetch.
  const { marks } = useRefundMarks();

  // Flagged leads held in the merged tab's raw order, but every live tab is
  // re-sorted by order ref below, so this only decides ties — the operator
  // reads Needs Attention by ref like the other queues.
  const attention = useMemo(() => [...flagged, ...held], [flagged, held]);

  const source = tab === 'pending'     ? pending
               : tab === 'attention'   ? attention
               : tab === 'priority'    ? priority
               : tab === 'approved'    ? approved
               : tab === 'cancelled'   ? cancelled
               : all;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? source
      : source.filter(o =>
          o.customer_name.toLowerCase().includes(q) ||
          o.order_ref.toLowerCase().includes(q) ||
          (o.customer_email ?? '').toLowerCase().includes(q),
        );
    // Live tabs are a work queue, so they read best by order ref. Cancelled is
    // a lookup list — the one you just killed should be at the top.
    if (tab === 'cancelled') return filtered;
    return [...filtered].sort((a, b) => a.order_ref.localeCompare(b.order_ref));
  }, [source, query, tab]);

  const refundFlags = useMemo(() => indexRefundFlags(visible, marks), [visible, marks]);
  // One query for the whole rail. Only 'unclear' reaches the row — see the
  // commConcern note on OrderRow.
  const { byOrderId: commAssessments } = useOrderCommAssessments();

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'pending',     label: 'Pending',         count: pending.length },
    { key: 'attention',   label: 'Needs Attention', count: held.length + flagged.length },
    { key: 'priority',    label: 'PRIORITY',        count: priority.length },
    { key: 'approved',    label: 'Confirmed',       count: approved.length },
    { key: 'all',         label: 'All',             count: all.length },
    { key: 'cancelled',   label: 'Cancelled',       count: cancelled.length },
  ];

  const activeTabLabel = tabs.find(t => t.key === tab)?.label ?? '';

  // Rendered from the constant itself, so moving the cutoff moves this label
  // too — a hardcoded date here would go stale the first time it changed.
  const cutoffLabel = new Date(`${SALES_QUEUE_START}T00:00:00`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Age is a module-wide filter now, so no tab holds a row back for being old.
  // Pending is the only queue with a rule of its own left — the money one — and
  // what it holds back is still in All, which is where the note points.
  const queueBacklog = tab === 'pending' ? pendingBacklog : [];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon} aria-hidden="true">⌕</span>
          <input
            className={styles.search}
            placeholder="Search name, email, order #"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >×</button>
          )}
        </div>

        {/* Six tabs wrap onto two rows. They used to scroll sideways, which put
            the last one off the edge of the rail. PRIORITY carries an amber
            accent so the one time-critical queue reads differently from the
            status tabs around it. */}
        <div className={styles.tabBar}>
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              className={[
                styles.tab,
                tab === t.key ? styles.activeTab : '',
                t.key === 'priority' ? styles.tabPriority : '',
                t.count === 0 ? styles.tabZero : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              // Without this the badge runs into the label and the tab
              // announces as "Flagged1".
              aria-label={`${t.label}: ${t.count} order${t.count === 1 ? '' : 's'}`}
            >
              {t.label}<span className={styles.tabCount}>{t.count}</span>
            </button>
          ))}
        </div>

      </div>

      {/* Every tab starts at the cutoff, so an older order is in none of them
          and search will not find it either. Say so once, here, rather than
          leaving someone to conclude the row was deleted. */}
      <div className={styles.railCount}>
        {visible.length} order{visible.length === 1 ? '' : 's'}{query.trim() ? ' matching' : ''}
        <span className={styles.railCutoff} title={`Sales shows orders placed on or after ${cutoffLabel}. Older orders still exist and are unchanged, but no tab lists them and search does not reach them.`}>
          {' '}· from {cutoffLabel}
        </span>
      </div>

      {/* A queue that quietly drops rows is a queue nobody can trust. When the
          cutoff is holding anything back, say how much and where it went. */}
      {queueBacklog.length > 0 && (
        <button
          type="button"
          className={styles.backlogNote}
          onClick={() => setTab('all')}
          title="Held back from this queue: already refunded, so there is nothing left to confirm, pick or ship. They keep their rows and stay searchable — click to see them in All."
        >
          {queueBacklog.length} held back from this queue — see All
        </button>
      )}

      <div className={styles.list}>
        {visible.length === 0 ? (
          query.trim() ? (
            <EmptyState
              title="No match"
              body={`Nothing in ${activeTabLabel} matches “${query.trim()}”. Try a different name, email or order number, or switch tabs.`}
            />
          ) : (
            <EmptyState
              title={`Nothing in ${activeTabLabel}`}
              body="Sync from Shopify to pull in orders placed since the last run."
            />
          )
        ) : visible.map((o, i) => (
          <OrderRow
            key={o.id}
            order={o}
            // Drives the load stagger. Capped at 14 so a long queue's last row
            // isn't held behind a quarter-second run-up it gains nothing from.
            revealIndex={Math.min(i, 14)}
            isSelected={o.id === selectedId}
            onClick={() => onSelect(o.id)}
            refundFlag={refundFlags.get(o.id) ?? null}
            commConcern={
              commAssessments[o.id]?.verdict === 'unclear'
                ? commAssessments[o.id].headline
                : null
            }
          />
        ))}
      </div>
    </aside>
  );
}
