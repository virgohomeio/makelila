import { useMemo, useState } from 'react';
import { useShippedUnits, shipmentTrackingUrl, type ShippedUnitRow } from '../../lib/shipping';
import { Button, EmptyState } from '../../components/ui';
import styles from './ShippingList.module.css';

// Fulfillment › Shipping. One row per shipped machine: customer, unit, ship
// date, cost, carrier, tracking number, and a link out to the carrier's
// tracking page. Shipments booked in the queue but not yet marked shipped are
// listed too, tagged Scheduled, since their tracking number already exists. Rebuilt from scratch 2026-10-21 — the old Freightcom
// quote/book dashboard was retired at the operator's request.

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function Cost({ row }: { row: ShippedUnitRow }) {
  if (row.shipping_cost == null) return <span className={styles.muted}>—</span>;
  return (
    <>
      ${Number(row.shipping_cost).toFixed(2)}
      {row.shipping_cost_currency && <span className={styles.currency}>{row.shipping_cost_currency}</span>}
    </>
  );
}

export function ShippingList() {
  const { rows, loading, error, refresh } = useShippedUnits();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      `${r.customer_name ?? ''} ${r.serial ?? ''} ${r.order_ref ?? ''} ${r.carrier ?? ''} ${r.tracking_num ?? ''}`
        .toLowerCase().includes(q),
    );
  }, [rows, search]);

  const scheduledCount = useMemo(() => rows.filter(r => r.scheduled).length, [rows]);

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search customer, unit, order, carrier or tracking #"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className={styles.count}>
          {filtered.length} of {rows.length} shipments
          {scheduledCount > 0 && ` · ${scheduledCount} scheduled, not yet marked shipped`}
        </span>
        <Button onClick={refresh}>Refresh</Button>
      </div>

      {error && <div className={styles.error}>Couldn't load everything: {error}</div>}

      {loading ? (
        <div className={styles.muted}>Loading shipments…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={rows.length ? 'No shipments match' : 'No shipped units yet'}
          body={rows.length ? 'Try a different search.' : 'Units appear here once they are marked shipped.'}
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Unit</th>
                <th>Ship date</th>
                <th className={styles.num}>Shipping cost</th>
                <th>Carrier</th>
                <th>Tracking #</th>
                <th>Track</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const url = shipmentTrackingUrl(r.carrier, r.tracking_num);
                return (
                  <tr key={r.key}>
                    <td>
                      {r.customer_name ?? <span className={styles.muted}>—</span>}
                      {r.order_ref && <span className={styles.sub}>{r.order_ref}</span>}
                    </td>
                    <td className={styles.mono}>{r.serial ?? <span className={styles.muted}>—</span>}</td>
                    <td>
                      {r.scheduled ? (
                        <>
                          <span className={styles.scheduled}>Scheduled</span>
                          {r.scheduled_at && <span className={styles.sub}>label {fmtDate(r.scheduled_at)}</span>}
                        </>
                      ) : fmtDate(r.shipped_at)}
                    </td>
                    <td className={styles.num}><Cost row={r} /></td>
                    <td>{r.carrier ?? <span className={styles.muted}>—</span>}</td>
                    <td className={styles.mono}>{r.tracking_num ?? <span className={styles.muted}>—</span>}</td>
                    <td>
                      {url ? (
                        <a className={styles.trackLink} href={url} target="_blank" rel="noopener noreferrer">
                          Track ↗
                        </a>
                      ) : <span className={styles.muted}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
