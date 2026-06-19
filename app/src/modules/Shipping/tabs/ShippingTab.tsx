import { useState } from 'react';
import { useQuotes, fetchFreightcomQuotes, selectQuote, type FreightQuote } from '../../../lib/freight';
import { useShipment, bookShipment } from '../../../lib/shipping';

type Props = { orderId: string };

export function ShippingTab({ orderId }: Props) {
  const { quotes, loading: quotesLoading } = useQuotes(orderId);
  const { shipment, loading: shipmentLoading } = useShipment(orderId);
  const [fetching, setFetching] = useState(false);
  const [booking,  setBooking]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const selectedQuote = quotes.find(q => q.selected) ?? null;

  async function handleFetchQuotes() {
    setFetching(true);
    setError(null);
    try {
      await fetchFreightcomQuotes(orderId);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetching(false);
    }
  }

  async function handleSelectQuote(quote: FreightQuote) {
    try {
      await selectQuote(orderId, quote.id);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleBook() {
    if (!selectedQuote) return;
    setBooking(true);
    setError(null);
    try {
      const result = await bookShipment(orderId, selectedQuote.id);
      if (result.label_url) {
        window.open(result.label_url, '_blank', 'noopener');
      }
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBooking(false);
    }
  }

  if (shipmentLoading || quotesLoading) return <div>Loading…</div>;

  // Already booked — show confirmation card
  if (shipment) {
    return (
      <div>
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Shipment Booked</h3>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <tbody>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Carrier</td><td>{shipment.carrier}</td></tr>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Service</td><td>{shipment.service}</td></tr>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Rate</td><td>{shipment.rate_cad ? `$${Number(shipment.rate_cad).toFixed(2)} CAD` : '—'}</td></tr>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Tracking</td><td>{shipment.primary_tracking_number ?? '—'}</td></tr>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Status</td><td style={{ textTransform: 'capitalize' }}>{shipment.status.replace('_', ' ')}</td></tr>
            <tr><td style={{ padding: '6px 12px 6px 0', color: '#718096' }}>Booked</td><td>{new Date(shipment.booked_at).toLocaleString()}</td></tr>
          </tbody>
        </table>
        {shipment.label_url && (
          <div style={{ marginTop: 16 }}>
            <a href={shipment.label_url} target="_blank" rel="noopener noreferrer"
               style={{ fontSize: 13, color: '#2b6cb0' }}>
              ↓ Download Label PDF
            </a>
          </div>
        )}
        <p style={{ marginTop: 16, fontSize: 12, color: '#a0aec0' }}>
          To cancel or re-book, void the shipment in the Freightcom portal first.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Rate Quotes</h3>
        <button
          onClick={handleFetchQuotes}
          disabled={fetching}
          style={{ fontSize: 13, padding: '6px 14px', background: '#1a202c', color: '#fff',
                   border: 'none', borderRadius: 4, cursor: fetching ? 'not-allowed' : 'pointer', opacity: fetching ? 0.6 : 1 }}
        >
          {fetching ? 'Fetching…' : quotes.length > 0 ? 'Refresh Quotes' : 'Fetch Quotes'}
        </button>
        {selectedQuote && (
          <button
            onClick={handleBook}
            disabled={booking}
            style={{ fontSize: 13, padding: '6px 14px', background: '#276749', color: '#fff',
                     border: 'none', borderRadius: 4, cursor: booking ? 'not-allowed' : 'pointer', opacity: booking ? 0.6 : 1 }}
          >
            {booking ? 'Booking…' : 'Book & Print Label'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: 4,
                      padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#c53030' }}>
          {error}
        </div>
      )}

      {quotes.length === 0 && !fetching && (
        <p style={{ color: '#a0aec0', fontSize: 13 }}>No quotes yet. Click "Fetch Quotes" to get rates from Freightcom.</p>
      )}

      {quotes.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f7fafc' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Carrier</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Service</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>Rate (CAD)</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>Days</th>
              <th style={{ padding: '8px 12px' }}></th>
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
                      style={{ background: q.selected ? '#f0fff4' : undefined,
                               borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '8px 12px' }}>{carrier ?? q.service_level}</td>
                    <td style={{ padding: '8px 12px', color: '#4a5568' }}>{service ?? '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {q.rate_cad != null ? `$${Number(q.rate_cad).toFixed(2)}` : q.rate_usd != null ? `$${Number(q.rate_usd).toFixed(2)} USD` : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#718096' }}>
                      {q.transit_days ?? '—'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
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
  );
}
