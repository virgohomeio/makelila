import { useMemo, useState } from 'react';
import type { Order } from '../../lib/orders';
import { OrderRow } from './OrderRow';
import styles from './OrderReview.module.css';

type Tab = 'pending' | 'held' | 'flagged' | 'approved' | 'all';

export function Sidebar({
  pending, held, flagged, approved, all,
  selectedId,
  onSelect,
}: {
  pending: Order[];
  held: Order[];
  flagged: Order[];
  approved: Order[];
  all: Order[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const [query, setQuery] = useState('');

  const source = tab === 'pending'  ? pending
               : tab === 'held'     ? held
               : tab === 'flagged'  ? flagged
               : tab === 'approved' ? approved
               : all;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter(o =>
      o.customer_name.toLowerCase().includes(q) ||
      o.order_ref.toLowerCase().includes(q) ||
      (o.customer_email ?? '').toLowerCase().includes(q),
    );
  }, [source, query]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'pending',  label: 'Pending',   count: pending.length },
    { key: 'held',     label: 'Held',      count: held.length },
    { key: 'flagged',  label: 'Flagged',   count: flagged.length },
    { key: 'approved', label: 'Confirmed', count: approved.length },
    { key: 'all',      label: 'All',       count: all.length },
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <div className={styles.tabBar}>
          {tabs.map(t => (
            <button
              key={t.key}
              className={`${styles.tab} ${tab === t.key ? styles.activeTab : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <input
          className={styles.search}
          placeholder="Search name, email, order #"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      <div className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.emptyList}>No orders in this tab.</div>
        ) : visible.map(o => (
          <OrderRow
            key={o.id}
            order={o}
            isSelected={o.id === selectedId}
            onClick={() => onSelect(o.id)}
          />
        ))}
      </div>
    </aside>
  );
}
