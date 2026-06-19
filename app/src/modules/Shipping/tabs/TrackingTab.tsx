import { useEffect, useState } from 'react';
import { useShipment, fetchTrackingEvents, type TrackingEvent } from '../../../lib/shipping';

type Props = { orderId: string };

export function TrackingTab({ orderId }: Props) {
  const { shipment, loading: shipmentLoading } = useShipment(orderId);
  const [events,  setEvents]  = useState<TrackingEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!shipment?.freightcom_shipment_id) return;
    let cancelled = false;
    setLoading(true);
    fetchTrackingEvents(shipment.freightcom_shipment_id)
      .then(evts => { if (!cancelled) { setEvents(evts); setLoading(false); } })
      .catch(e  => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [shipment?.freightcom_shipment_id]);

  if (shipmentLoading) return <div>Loading…</div>;

  if (!shipment) {
    return (
      <div style={{ color: '#a0aec0', fontSize: 14, marginTop: 24 }}>
        No shipment booked for this order yet. Book a shipment in the Shipping tab first.
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Tracking</h3>
        <div style={{ fontSize: 13, color: '#4a5568' }}>
          {shipment.carrier} · {shipment.primary_tracking_number ?? 'No tracking number'}
        </div>
      </div>

      {error && (
        <div style={{ background: '#fff5f5', border: '1px solid #fc8181', borderRadius: 4,
                      padding: '10px 14px', fontSize: 13, color: '#c53030', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && <div style={{ color: '#718096', fontSize: 13 }}>Loading tracking events…</div>}

      {!loading && events.length === 0 && !error && (
        <div style={{ color: '#a0aec0', fontSize: 13 }}>
          No tracking events yet. The carrier may not have scanned the shipment.
        </div>
      )}

      {events.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {events.map((evt, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, paddingBottom: 16, position: 'relative' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%',
                              background: i === 0 ? '#276749' : '#cbd5e0', flexShrink: 0, marginTop: 3 }} />
                {i < events.length - 1 && (
                  <div style={{ width: 2, flex: 1, background: '#e2e8f0', minHeight: 24 }} />
                )}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: i === 0 ? 600 : 400 }}>
                  {typeof evt.description === 'string' ? evt.description : JSON.stringify(evt.description)}
                </div>
                {evt.location && (
                  <div style={{ fontSize: 12, color: '#718096', marginTop: 2 }}>
                    {String(evt.location)}
                  </div>
                )}
                <div style={{ fontSize: 11, color: '#a0aec0', marginTop: 2 }}>
                  {evt.timestamp ? new Date(String(evt.timestamp)).toLocaleString() : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
