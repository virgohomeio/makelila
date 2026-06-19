import { useEffect, useState } from 'react';
import { useShipment, fetchInvoices, type FreightcomInvoice } from '../../../lib/shipping';

type Props = { orderId: string };

function InvoiceTable({ invoices, loading, error, emptyMsg }: {
  invoices: FreightcomInvoice[];
  loading: boolean;
  error: string | null;
  emptyMsg: string;
}) {
  if (loading) return <div style={{ color: '#718096', fontSize: 13 }}>Loading…</div>;
  if (error)   return <div style={{ color: '#c53030', fontSize: 13 }}>{error}</div>;
  if (invoices.length === 0) return <div style={{ color: '#a0aec0', fontSize: 13 }}>{emptyMsg}</div>;

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#f7fafc' }}>
          <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Invoice #</th>
          <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Type</th>
          <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600 }}>Date</th>
          <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Amount</th>
          <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Owing</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map(inv => (
          <tr key={inv.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
            <td style={{ padding: '7px 12px' }}>{inv.number}</td>
            <td style={{ padding: '7px 12px', color: '#4a5568', textTransform: 'capitalize' }}>{inv.type}</td>
            <td style={{ padding: '7px 12px', color: '#4a5568' }}>
              {inv.date ? new Date(inv.date).toLocaleDateString() : '—'}
            </td>
            <td style={{ padding: '7px 12px', textAlign: 'right' }}>
              {Number.isFinite(Number(inv.amount)) ? `$${Number(inv.amount).toFixed(2)}` : inv.amount}
            </td>
            <td style={{ padding: '7px 12px', textAlign: 'right', color: Number(inv.owing) > 0 ? '#c53030' : '#276749' }}>
              {Number.isFinite(Number(inv.owing)) ? `$${Number(inv.owing).toFixed(2)}` : inv.owing}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InvoicesTab({ orderId }: Props) {
  const { shipment, loading: shipmentLoading } = useShipment(orderId);

  const [shipmentInvoices, setShipmentInvoices] = useState<FreightcomInvoice[]>([]);
  const [shipmentInvoicesLoading, setShipmentInvoicesLoading] = useState(false);
  const [shipmentInvoicesError,   setShipmentInvoicesError]   = useState<string | null>(null);

  const [allInvoices, setAllInvoices] = useState<FreightcomInvoice[]>([]);
  const [allInvoicesLoading, setAllInvoicesLoading] = useState(false);
  const [allInvoicesError,   setAllInvoicesError]   = useState<string | null>(null);

  useEffect(() => {
    if (!shipment?.freightcom_shipment_id) return;
    let cancelled = false;
    setShipmentInvoicesLoading(true);
    fetchInvoices('shipment', { freightcomShipmentId: shipment.freightcom_shipment_id })
      .then(invs => { if (!cancelled) { setShipmentInvoices(invs); setShipmentInvoicesLoading(false); } })
      .catch(e  => { if (!cancelled) { setShipmentInvoicesError(e.message); setShipmentInvoicesLoading(false); } });
    return () => { cancelled = true; };
  }, [shipment?.freightcom_shipment_id]);

  useEffect(() => {
    let cancelled = false;
    setAllInvoicesLoading(true);
    fetchInvoices('date_range', { days: 90 })
      .then(invs => { if (!cancelled) { setAllInvoices(invs); setAllInvoicesLoading(false); } })
      .catch(e  => { if (!cancelled) { setAllInvoicesError(e.message); setAllInvoicesLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (shipmentLoading) return <div>Loading…</div>;

  return (
    <div>
      {shipment?.freightcom_shipment_id && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>This Shipment</h3>
          <InvoiceTable
            invoices={shipmentInvoices}
            loading={shipmentInvoicesLoading}
            error={shipmentInvoicesError}
            emptyMsg="No invoices found for this shipment yet."
          />
        </section>
      )}

      <section>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>All Freightcom Invoices (last 90 days)</h3>
        <InvoiceTable
          invoices={allInvoices}
          loading={allInvoicesLoading}
          error={allInvoicesError}
          emptyMsg="No invoices found in the last 90 days."
        />
      </section>
    </div>
  );
}
