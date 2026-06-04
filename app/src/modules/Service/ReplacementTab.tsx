import { useMemo, useState } from 'react';
import { useReplacementOrders, type Order } from '../../lib/orders';
import { isReplacementLine } from '../../lib/orders';
import styles from './Service.module.css';

type Stage = 'pending' | 'approved' | 'fulfilling' | 'shipped' | 'delivered' | 'closed';

function stageFor(o: Order): Stage {
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
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'fulfilling', label: 'Fulfilling' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'closed', label: 'Closed' },
];

export default function ReplacementTab() {
  const { orders, loading } = useReplacementOrders();
  const [filter, setFilter] = useState<Stage | 'all'>('all');

  const filtered = useMemo(
    () => orders.filter(o => filter === 'all' || stageFor(o) === filter),
    [orders, filter],
  );

  const now = Date.now();
  const monthAgo = now - 30 * 86400_000;
  const open = orders.filter(o => !o.delivered_at).length;
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
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Shipped (30d)</div><div className={styles.kpiValue}>{shipped30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Delivered (30d)</div><div className={styles.kpiValue}>{delivered30}</div></div>
        <div className={styles.kpiCard}><div className={styles.kpiLabel}>Avg COGS (30d)</div><div className={styles.kpiValue}>{avgCogs == null ? '—' : `$${avgCogs.toFixed(2)}`}</div></div>
      </div>

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
              return (
                <tr key={o.id} className={styles.row}>
                  <td><a href="#/order-review">{o.order_ref}</a></td>
                  <td>{o.linked_ticket_id ? <a href="#/service">open</a> : '—'}</td>
                  <td>{o.customer_name}</td>
                  <td>{summarize(o.line_items)}</td>
                  <td>${(o.cogs_usd ?? 0).toFixed(2)}</td>
                  <td>{stageFor(o)}</td>
                  <td>{daysOpen}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
