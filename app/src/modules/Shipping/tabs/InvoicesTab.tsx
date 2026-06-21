import { useState, useEffect } from 'react';
import { fetchInvoices, type FreightcomInvoice } from '../../../lib/shipping';

export function InvoicesTab() {
  const [invoices, setInvoices] = useState<FreightcomInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInvoices('date_range', { days: 90 })
      .then(invs => { if (!cancelled) { setInvoices(invs); setLoading(false); } })
      .catch(e   => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div style={{ color: '#718096', fontSize: 13 }}>Loading…</div>;
  if (error)   return <div style={{ color: '#c53030', fontSize: 13 }}>{error}</div>;

  if (invoices.length === 0) {
    return <p style={{ color: '#a0aec0', fontSize: 13 }}>No invoices found in the last 90 days.</p>;
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#1a202c' }}>
        Freightcom Invoices — last 90 days
      </h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f7fafc' }}>
            <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Invoice #</th>
            <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Type</th>
            <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Date</th>
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
    </div>
  );
}
