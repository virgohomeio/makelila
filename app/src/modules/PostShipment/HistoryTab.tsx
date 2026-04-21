import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useFulfillmentQueue } from '../../lib/fulfillment';
import styles from './PostShipment.module.css';

type Order = {
  id: string;
  order_ref: string;
  customer_name: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
};

export function HistoryTab() {
  const { fulfilled, loading: qLoading } = useFulfillmentQueue();
  const [orders, setOrders] = useState<Order[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const ids = Array.from(new Set(fulfilled.map(r => r.order_id)));
    if (ids.length === 0) return;
    void supabase
      .from('orders')
      .select('id, order_ref, customer_name, city, region_state, country')
      .in('id', ids)
      .then(({ data }) => setOrders((data as Order[]) ?? []));
  }, [fulfilled]);

  const orderLookup = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  const rows = useMemo(() => {
    const base = [...fulfilled].sort((a, b) => {
      const ta = a.fulfilled_at ?? a.created_at;
      const tb = b.fulfilled_at ?? b.created_at;
      return tb.localeCompare(ta);
    });
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(r => {
      const o = orderLookup.get(r.order_id);
      return (
        o?.customer_name.toLowerCase().includes(q) ||
        o?.order_ref.toLowerCase().includes(q) ||
        r.assigned_serial?.toLowerCase().includes(q) ||
        r.tracking_num?.toLowerCase().includes(q) ||
        r.carrier?.toLowerCase().includes(q)
      );
    });
  }, [fulfilled, orderLookup, search]);

  // KPI aggregates
  const stats = useMemo(() => {
    const s = {
      total: fulfilled.length,
      last7: 0,
      last30: 0,
      us: 0,
      ca: 0,
    };
    const now = Date.now();
    const d7 = now - 7 * 86_400_000;
    const d30 = now - 30 * 86_400_000;
    for (const r of fulfilled) {
      const o = orderLookup.get(r.order_id);
      if (o?.country === 'US') s.us++;
      if (o?.country === 'CA') s.ca++;
      const t = r.fulfilled_at ? new Date(r.fulfilled_at).getTime() : 0;
      if (t >= d7) s.last7++;
      if (t >= d30) s.last30++;
    }
    return s;
  }, [fulfilled, orderLookup]);

  if (qLoading) return <div className={styles.loading}>Loading fulfillment history…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total fulfilled" value={stats.total} />
        <KPI label="Last 7 days" value={stats.last7} />
        <KPI label="Last 30 days" value={stats.last30} />
        <KPI label="Canada / US" value={`${stats.ca} / ${stats.us}`} />
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, order #, serial, carrier…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Fulfilled</th>
              <th>Customer</th>
              <th>Order #</th>
              <th>Destination</th>
              <th>Serial</th>
              <th>Carrier</th>
              <th>Tracking</th>
              <th>Email sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const o = orderLookup.get(r.order_id);
              return (
                <tr key={r.id}>
                  <td className={styles.mono}>{formatDate(r.fulfilled_at)}</td>
                  <td>{o?.customer_name ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{o?.order_ref ?? '—'}</td>
                  <td>
                    {o ? (
                      <span>{o.city}{o.region_state ? `, ${o.region_state}` : ''} · {o.country}</span>
                    ) : <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.mono}>{r.assigned_serial ?? <span className={styles.muted}>—</span>}</td>
                  <td>{r.carrier ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{r.tracking_num ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{formatDate(r.email_sent_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function KPI({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

