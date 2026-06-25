import { useState } from 'react';
import {
  useShippingOrders, useAllShipments, bookShipment,
  refreshFreightcomStatuses, displayFreightcomStatus, isKnownFreightcomStatus,
  FREIGHTCOM_STATUSES, type AllShipmentRow,
} from '../../../lib/shipping';
import { useQuotes, fetchFreightcomQuotes, selectQuote, type FreightQuote } from '../../../lib/freight';
import styles from '../Shipping.module.css';

// Map Freightcom's raw status vocabulary to the existing badge colour classes.
const FC_BADGE_CLASS: Record<string, string> = {
  'waiting-for-transit': styles.statusBooked,
  'in-transit':          styles.statusInTransit,
  'delivered':           styles.statusDelivered,
  'exception':           styles.statusException,
  'missing':             styles.statusMissing,
  'cancelled':           styles.statusCancelled,
};

type Filter = 'all' | typeof FREIGHTCOM_STATUSES[number] | 'other' | 'returns';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',                 label: 'All'                 },
  { id: 'waiting-for-transit', label: 'Waiting for transit' },
  { id: 'in-transit',          label: 'In transit'          },
  { id: 'delivered',           label: 'Delivered'           },
  { id: 'exception',           label: 'Exception'           },
  { id: 'missing',             label: 'Missing'             },
  { id: 'cancelled',           label: 'Cancelled'           },
  { id: 'other',               label: 'Other'               },
  { id: 'returns',             label: '↩ Returns'           },
];

export function ShippingTab() {
  // Book a label
  const { orders, loading: ordersLoading } = useShippingOrders();
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const { quotes, loading: quotesLoading } = useQuotes(selectedOrderId || null);
  const [fetching, setFetching] = useState(false);
  const [booking,  setBooking]  = useState(false);
  const [bookErr,  setBookErr]  = useState<string | null>(null);

  // Dashboard
  const { shipments, loading: shipmentsLoading } = useAllShipments();
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const unshippedOrders = orders.filter(o => o.shipment_status === null);
  const selectedQuote   = quotes.find(q => q.selected) ?? null;

  const matchesFilter = (s: AllShipmentRow) => {
    if (filter === 'all') return true;
    if (filter === 'returns') return s.direction === 'return';
    const fc = displayFreightcomStatus(s);
    if (filter === 'other') return !isKnownFreightcomStatus(fc);
    return fc === filter;
  };
  const filteredShipments = shipments.filter(matchesFilter);

  async function handleRefreshStatuses() {
    setRefreshErr(null);
    setRefreshing(true);
    try {
      const results = await refreshFreightcomStatuses(
        filteredShipments.map(s => ({ id: s.id, freightcom_shipment_id: s.freightcom_shipment_id })),
      );
      const failed = results.filter(r => r.error).length;
      if (failed > 0) setRefreshErr(`${failed} shipment(s) could not be refreshed.`);
      // useAllShipments has no refetch fn; reload to pull the persisted statuses.
      window.location.reload();
    } catch (e) {
      setRefreshErr((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleFetchQuotes() {
    if (!selectedOrderId) return;
    setFetching(true);
    setBookErr(null);
    try {
      await fetchFreightcomQuotes(selectedOrderId);
      window.location.reload();
    } catch (e) {
      setBookErr((e as Error).message);
    } finally {
      setFetching(false);
    }
  }

  async function handleSelectQuote(q: FreightQuote) {
    if (!selectedOrderId) return;
    try {
      await selectQuote(selectedOrderId, q.id);
      window.location.reload();
    } catch (e) {
      setBookErr((e as Error).message);
    }
  }

  async function handleBook() {
    if (!selectedOrderId || !selectedQuote) return;
    setBooking(true);
    setBookErr(null);
    try {
      const shipment = await bookShipment(selectedOrderId, selectedQuote.id);
      if (shipment.label_url) window.open(shipment.label_url, '_blank', 'noopener');
      window.location.reload();
    } catch (e) {
      setBookErr((e as Error).message);
    } finally {
      setBooking(false);
    }
  }

  return (
    <div>
      {/* ── Book a Label ─────────────────────────────────────────────── */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Book a Label</h3>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <select
            value={selectedOrderId}
            onChange={e => { setSelectedOrderId(e.target.value); setBookErr(null); }}
            disabled={ordersLoading}
            style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4, minWidth: 240 }}
          >
            <option value="">— Select order —</option>
            {unshippedOrders.map(o => (
              <option key={o.order_id} value={o.order_id}>
                {o.order_ref} — {o.customer_name}
              </option>
            ))}
          </select>

          {selectedOrderId && (
            <button
              onClick={handleFetchQuotes}
              disabled={fetching}
              style={{ fontSize: 13, padding: '7px 14px', background: '#1a202c', color: '#fff',
                       border: 'none', borderRadius: 4, cursor: fetching ? 'not-allowed' : 'pointer', opacity: fetching ? 0.6 : 1 }}
            >
              {fetching ? 'Fetching…' : quotes.length > 0 ? 'Refresh Quotes' : 'Get Quotes'}
            </button>
          )}

          {selectedQuote && (
            <button
              onClick={handleBook}
              disabled={booking}
              style={{ fontSize: 13, padding: '7px 14px', background: '#276749', color: '#fff',
                       border: 'none', borderRadius: 4, cursor: booking ? 'not-allowed' : 'pointer', opacity: booking ? 0.6 : 1 }}
            >
              {booking ? 'Booking…' : 'Book & Print Label'}
            </button>
          )}
        </div>

        {bookErr && (
          <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: 4,
                        padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#c53030' }}>
            {bookErr}
          </div>
        )}

        {selectedOrderId && !quotesLoading && quotes.length === 0 && !fetching && (
          <p style={{ color: '#a0aec0', fontSize: 13 }}>No quotes yet. Click "Get Quotes" to fetch rates from Freightcom.</p>
        )}

        {selectedOrderId && quotes.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, maxWidth: 640 }}>
            <thead>
              <tr style={{ background: '#f7fafc' }}>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Carrier</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Service</th>
                <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Rate (CAD)</th>
                <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Days</th>
                <th style={{ padding: '7px 12px' }}></th>
              </tr>
            </thead>
            <tbody>
              {quotes
                .slice()
                .sort((a, b) => (a.rate_cad ?? 999) - (b.rate_cad ?? 999))
                .map(q => {
                  const [carrier, service] = q.service_level.split(' — ');
                  return (
                    <tr key={q.id}
                        style={{ background: q.selected ? '#f0fff4' : undefined, borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '7px 12px' }}>{carrier ?? q.service_level}</td>
                      <td style={{ padding: '7px 12px', color: '#4a5568' }}>{service ?? '—'}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                        {q.rate_cad != null ? `$${Number(q.rate_cad).toFixed(2)}` : q.rate_usd != null ? `$${Number(q.rate_usd).toFixed(2)} USD` : '—'}
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: '#718096' }}>
                        {q.transit_days ?? '—'}
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                        {q.selected ? (
                          <span style={{ color: '#276749', fontWeight: 600, fontSize: 12 }}>✓ Selected</span>
                        ) : (
                          <button
                            onClick={() => handleSelectQuote(q)}
                            style={{ fontSize: 12, padding: '4px 10px', background: '#1a202c', color: '#fff',
                                     border: 'none', borderRadius: 3, cursor: 'pointer' }}
                          >
                            Select
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── All Shipments Dashboard ──────────────────────────────────── */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>All Shipments</h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0' }}>
          <button
            onClick={handleRefreshStatuses}
            disabled={refreshing || filteredShipments.length === 0}
            style={{ fontSize: 13, padding: '5px 12px', cursor: refreshing ? 'not-allowed' : 'pointer' }}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh from Freightcom'}
          </button>
          {refreshErr && (
            <span style={{ fontSize: 12, color: '#c53030' }}>{refreshErr}</span>
          )}
        </div>

        <div className={styles.chips}>
          {FILTERS.map(f => {
            const count = f.id === 'all'
              ? shipments.length
              : f.id === 'returns'
              ? shipments.filter(s => s.direction === 'return').length
              : shipments.filter(s => {
                  const fc = displayFreightcomStatus(s);
                  return f.id === 'other' ? !isKnownFreightcomStatus(fc) : fc === f.id;
                }).length;
            return (
              <button
                key={f.id}
                className={`${styles.chip} ${filter === f.id ? styles.chipActive : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}{count > 0 ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>

        {shipmentsLoading ? (
          <p style={{ color: '#718096', fontSize: 13 }}>Loading…</p>
        ) : filteredShipments.length === 0 ? (
          <p style={{ color: '#a0aec0', fontSize: 13 }}>
            No {filter !== 'all' ? `"${filter}" ` : ''}shipments yet.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f7fafc' }}>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Order</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Customer</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Direction</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Carrier</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Service</th>
                <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Rate (CAD)</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Tracking</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Freightcom status</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Booked</th>
                <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Synced</th>
                <th style={{ padding: '7px 12px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredShipments.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '7px 12px', fontWeight: 600, fontSize: 12 }}>{s.order_ref || '—'}</td>
                  <td style={{ padding: '7px 12px', color: '#4a5568' }}>{s.counterparty_name || '—'}</td>
                  <td style={{ padding: '7px 12px' }}>
                    {s.direction === 'return' ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#9c4221',
                                     background: '#feebc8', borderRadius: 4, padding: '2px 7px' }}>
                        ↩ Return
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#718096',
                                     background: '#edf2f7', borderRadius: 4, padding: '2px 7px' }}>
                        ↑ Outbound
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '7px 12px' }}>{s.carrier}</td>
                  <td style={{ padding: '7px 12px', color: '#4a5568' }}>{s.service}</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                    {s.rate_cad != null ? `$${Number(s.rate_cad).toFixed(2)}` : '—'}
                  </td>
                  <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: '#4a5568' }}>
                    {s.primary_tracking_number ?? '—'}
                  </td>
                  <td style={{ padding: '7px 12px' }}>
                    {(() => {
                      const fc = displayFreightcomStatus(s);
                      return (
                        <span className={`${styles.statusBadge} ${FC_BADGE_CLASS[fc] ?? ''}`}>
                          {fc}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={{ padding: '7px 12px', color: '#718096', fontSize: 12 }}>
                    {new Date(s.booked_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '7px 12px', color: '#a0aec0', fontSize: 12 }}>
                    {s.status_synced_at ? new Date(s.status_synced_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                    {s.label_url && (
                      <a href={s.label_url} target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: 12, color: '#2b6cb0' }}>Label</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
