import { useMemo, useState } from 'react';
import type { Order } from '../../lib/orders';
import { supabase } from '../../lib/supabase';
import { OrderRow } from './OrderRow';
import styles from './OrderReview.module.css';

type Tab = 'pending' | 'held' | 'flagged' | 'approved' | 'all';

type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; imported: number; skipped: number }
  | { kind: 'error'; message: string };

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
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });

  const source = tab === 'pending'  ? pending
               : tab === 'held'     ? held
               : tab === 'flagged'  ? flagged
               : tab === 'approved' ? approved
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
    return [...filtered].sort((a, b) => a.order_ref.localeCompare(b.order_ref));
  }, [source, query]);

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'pending',  label: 'Pending',   count: pending.length },
    { key: 'held',     label: 'Held',      count: held.length },
    { key: 'flagged',  label: 'Flagged',   count: flagged.length },
    { key: 'approved', label: 'Confirmed', count: approved.length },
    { key: 'all',      label: 'All',       count: all.length },
  ];

  const runSync = async () => {
    setSync({ kind: 'syncing' });
    const { data, error } = await supabase.functions.invoke<{
      fetched: number;
      imported: number;
      skipped: number;
    }>('sync-shopify-orders', { body: {} });
    if (error) {
      setSync({ kind: 'error', message: error.message });
      return;
    }
    if (!data) {
      setSync({ kind: 'error', message: 'empty response' });
      return;
    }
    setSync({ kind: 'done', imported: data.imported, skipped: data.skipped });
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <div className={styles.syncRow}>
          <button
            className={styles.syncBtn}
            onClick={runSync}
            disabled={sync.kind === 'syncing'}
          >
            {sync.kind === 'syncing' ? 'Syncing…' : '⟲ Sync from Shopify'}
          </button>
          <div className={styles.syncStatus}>
            {sync.kind === 'done' &&
              `${sync.imported} new · ${sync.skipped} skipped`}
            {sync.kind === 'error' && (
              <span className={styles.syncError}>Failed: {sync.message}</span>
            )}
          </div>
        </div>

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
