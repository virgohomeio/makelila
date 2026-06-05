import { useMemo, useState } from 'react';
import { useFulfillmentLog, type FulfillmentLogRow } from '../../lib/fulfillment';
import { formatMoney } from '../../lib/money';
import styles from './Fulfillment.module.css';

// Per operator (2026-06-05): shipped replacement orders + shipped sales
// from the historical Excel don't need to go through the in-app
// approval/queue/ship workflow. Instead they live in fulfillment_log
// (imported from LILA customer fulfillment-20260605.xlsx) and we surface
// them here for lookup.

type SourceFilter = 'all' | 'Replacement' | 'Canada Shipping' | 'US Shipping' | 'Personal Delivery';
type ShippedFilter = 'all' | 'shipped' | 'pending';

const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: 'all',               label: 'All' },
  { key: 'Replacement',       label: 'Replacement' },
  { key: 'Canada Shipping',   label: 'Canada' },
  { key: 'US Shipping',       label: 'US' },
  { key: 'Personal Delivery', label: 'Personal' },
];

export default function FulfillmentHistory() {
  const { rows, loading } = useFulfillmentLog();
  const [source, setSource] = useState<SourceFilter>('all');
  const [shipped, setShipped] = useState<ShippedFilter>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (source !== 'all' && r.source_tab !== source) return false;
      if (shipped === 'shipped' && !r.tracking_number) return false;
      if (shipped === 'pending' && r.tracking_number) return false;
      if (q) {
        const hay = `${r.customer_name ?? ''} ${r.email ?? ''} ${r.serial_number ?? ''} ${r.tracking_number ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, source, shipped, search]);

  // Counts driving the chip badges
  const counts = useMemo(() => {
    const c: Record<SourceFilter, number> = {
      all: rows.length,
      Replacement: 0, 'Canada Shipping': 0, 'US Shipping': 0, 'Personal Delivery': 0,
    };
    let shippedCount = 0;
    for (const r of rows) {
      const tab = r.source_tab as SourceFilter;
      if (tab in c && tab !== 'all') c[tab]++;
      if (r.tracking_number) shippedCount++;
    }
    return { ...c, shipped: shippedCount, pending: rows.length - shippedCount };
  }, [rows]);

  if (loading) return <div className={styles.histLoading}>Loading history…</div>;

  return (
    <div className={styles.histTab}>
      <div className={styles.histHeader}>
        <h3 className={styles.histTitle}>Fulfillment History</h3>
        <div className={styles.histHint}>
          Historical records imported from <code>LILA customer fulfillment-20260605.xlsx</code>.
          Shipped rows have a tracking number; pending rows are awaiting fulfillment.
        </div>
      </div>

      <div className={styles.histControls}>
        <div className={styles.histChips}>
          {SOURCES.map(s => (
            <button
              key={s.key}
              className={`${styles.histChip} ${source === s.key ? styles.histChipActive : ''}`}
              onClick={() => setSource(s.key)}
            >
              {s.label} <span className={styles.histChipCount}>
                {s.key === 'all' ? counts.all : counts[s.key]}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.histChips}>
          <button
            className={`${styles.histChip} ${shipped === 'all' ? styles.histChipActive : ''}`}
            onClick={() => setShipped('all')}
          >Any status</button>
          <button
            className={`${styles.histChip} ${shipped === 'shipped' ? styles.histChipActive : ''}`}
            onClick={() => setShipped('shipped')}
          >Shipped <span className={styles.histChipCount}>{counts.shipped}</span></button>
          <button
            className={`${styles.histChip} ${shipped === 'pending' ? styles.histChipActive : ''}`}
            onClick={() => setShipped('pending')}
          >Pending <span className={styles.histChipCount}>{counts.pending}</span></button>
        </div>
        <input
          className={styles.histSearch}
          placeholder="Search name, email, serial, tracking…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className={styles.histResultCount}>{filtered.length} rows</div>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.histEmpty}>No fulfillment records match these filters.</div>
      ) : (
        <table className={styles.histTable}>
          <thead>
            <tr>
              <th>Source</th>
              <th>Shipped</th>
              <th>Customer</th>
              <th>Item / batch</th>
              <th>Serial</th>
              <th>Carrier · Tracking</th>
              <th>Shipping</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => <HistoryRow key={r.id} row={r} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HistoryRow({ row: r }: { row: FulfillmentLogRow }) {
  const shipped = !!r.tracking_number;
  return (
    <tr className={styles.histRow}>
      <td><span className={styles.histSourceTag}>{r.source_tab}</span></td>
      <td className={styles.histMono}>{r.shipping_date ?? <span className={styles.histMuted}>—</span>}</td>
      <td>
        <div>{r.customer_name ?? <span className={styles.histMuted}>—</span>}</div>
        {r.email && <div className={styles.histSubtext}>{r.email}</div>}
      </td>
      <td>
        {r.batch ?? <span className={styles.histMuted}>—</span>}
        {r.color && <span className={styles.histSubtext}> · {r.color}</span>}
      </td>
      <td className={styles.histMono}>{r.serial_number ?? <span className={styles.histMuted}>—</span>}</td>
      <td className={styles.histMono}>
        {r.tracking_number
          ? <span title={r.carrier ?? ''}>{r.carrier ? `${r.carrier} · ` : ''}{r.tracking_number}</span>
          : <span className={styles.histMuted}>—</span>}
      </td>
      <td className={styles.histMono}>{r.price != null ? formatMoney(r.price, 'USD') : <span className={styles.histMuted}>—</span>}</td>
      <td>
        {shipped
          ? <span className={styles.histStatusShipped}>{r.update_status ?? 'Shipped'}</span>
          : <span className={styles.histStatusPending}>Pending</span>}
      </td>
    </tr>
  );
}
