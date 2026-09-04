import { useMemo, useState } from 'react';
import type { Order } from '../../lib/orders';
import { OrderRow } from './OrderRow';
import { indexRefundFlags, useRefundMarks } from '../../lib/refundedOrders';
import { EmptyState } from '../../components/ui';
import styles from './OrderReview.module.css';

type Tab = 'pending' | 'held' | 'flagged' | 'approved' | 'all' | 'cancelled';

export function Sidebar({
  pending, held, flagged, approved, all, cancelled,
  selectedId,
  onSelect,
}: {
  pending: Order[];
  held: Order[];
  flagged: Order[];
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

  const source = tab === 'pending'     ? pending
               : tab === 'held'        ? held
               : tab === 'flagged'     ? flagged
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

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'pending',     label: 'Pending',     count: pending.length },
    { key: 'held',        label: 'Held',        count: held.length },
    { key: 'flagged',     label: 'Flagged',     count: flagged.length },
    { key: 'approved',    label: 'Confirmed',   count: approved.length },
    { key: 'all',         label: 'All',         count: all.length },
    { key: 'cancelled',   label: 'Cancelled',   count: cancelled.length },
  ];

  const activeTabLabel = tabs.find(t => t.key === tab)?.label ?? '';

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

        {/* Seven statuses wrap onto two rows. They used to scroll sideways,
            which put Cancelled off the edge of the rail. */}
        <div className={styles.tabBar}>
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              className={[
                styles.tab,
                tab === t.key ? styles.activeTab : '',
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

      <div className={styles.railCount}>
        {visible.length} order{visible.length === 1 ? '' : 's'}{query.trim() ? ' matching' : ''}
      </div>

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
          />
        ))}
      </div>
    </aside>
  );
}
