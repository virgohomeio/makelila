import { useState } from 'react';
import { useShipment, useClaims, fileClaim, type ClaimReason } from '../../../lib/shipping';

type Props = { orderId: string };

const REASON_LABELS: Record<ClaimReason, string> = {
  damage:  'Damage',
  lost:    'Loss',
  late:    'Delay',
  other:   'Other',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ClaimsTab({ orderId }: Props) {
  const { shipment, loading: shipmentLoading } = useShipment(orderId);
  const { claims, loading: claimsLoading } = useClaims(orderId);

  const [reason,     setReason]     = useState<ClaimReason>('damage');
  const [amount,     setAmount]     = useState('');
  const [notes,      setNotes]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState<string | null>(null);

  if (shipmentLoading) return <div style={{ color: '#718096', fontSize: 13, marginTop: 24 }}>Loading…</div>;

  if (!shipment) {
    return (
      <div style={{ color: '#a0aec0', fontSize: 14, marginTop: 24 }}>
        No shipment booked. Book a shipment in the Shipping tab first.
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitErr(null);
    setSubmitting(true);
    try {
      const amountCad = amount ? parseFloat(amount) : null;
      await fileClaim(orderId, shipment!.id, reason, amountCad, notes.trim() || null);
      window.location.reload();
    } catch (err: unknown) {
      setSubmitErr(err instanceof Error ? err.message : 'Failed to file claim');
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>

      {/* ── Existing Claims ─────────────────────────────────────────────── */}
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Existing Claims</h3>

        {claimsLoading ? (
          <div style={{ color: '#718096', fontSize: 13 }}>Loading claims…</div>
        ) : claims.length === 0 ? (
          <div style={{ color: '#a0aec0', fontSize: 13 }}>No claims filed for this shipment.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                <th style={{ padding: '6px 12px 6px 0', fontWeight: 600, color: '#4a5568' }}>Claim&nbsp;ID</th>
                <th style={{ padding: '6px 12px 6px 0', fontWeight: 600, color: '#4a5568' }}>Filed</th>
                <th style={{ padding: '6px 12px 6px 0', fontWeight: 600, color: '#4a5568' }}>Type</th>
                <th style={{ padding: '6px 12px 6px 0', fontWeight: 600, color: '#4a5568' }}>Status</th>
                <th style={{ padding: '6px 12px 6px 0', fontWeight: 600, color: '#4a5568' }}>Amount</th>
                <th style={{ padding: '6px 0',           fontWeight: 600, color: '#4a5568' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {claims.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f7fafc' }}>
                  <td style={{ padding: '8px 12px 8px 0', fontFamily: 'monospace', fontSize: 11, color: '#718096' }}>
                    {c.id.slice(0, 8)}
                  </td>
                  <td style={{ padding: '8px 12px 8px 0' }}>{formatDate(c.filed_at)}</td>
                  <td style={{ padding: '8px 12px 8px 0' }}>{REASON_LABELS[c.reason] ?? c.reason}</td>
                  <td style={{ padding: '8px 12px 8px 0' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 11,
                      fontWeight: 600,
                      background: c.status === 'open' ? '#ebf8ff' : c.status === 'resolved' ? '#f0fff4' : c.status === 'denied' ? '#fff5f5' : '#fefcbf',
                      color:      c.status === 'open' ? '#2b6cb0' : c.status === 'resolved' ? '#276749'  : c.status === 'denied' ? '#c53030' : '#744210',
                    }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px 8px 0' }}>
                    {c.amount_cad != null ? `$${c.amount_cad.toFixed(2)} CAD` : '—'}
                  </td>
                  <td style={{ padding: '8px 0', color: '#718096', maxWidth: 240, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.notes ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── File a New Claim ─────────────────────────────────────────────── */}
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>File a New Claim</h3>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420 }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#4a5568' }}>Type</label>
            <select
              value={reason}
              onChange={e => setReason(e.target.value as ClaimReason)}
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4, background: '#fff' }}
            >
              <option value="damage">Damage</option>
              <option value="lost">Loss</option>
              <option value="late">Delay</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#4a5568' }}>Amount (CAD)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4 }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#4a5568' }}>Notes <span style={{ fontWeight: 400, color: '#a0aec0' }}>(optional)</span></label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Describe the damage, loss, or issue…"
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {submitErr && (
            <div style={{ fontSize: 13, color: '#c53030' }}>{submitErr}</div>
          )}

          <div>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: '8px 20px',
                fontSize: 13,
                fontWeight: 600,
                background: submitting ? '#a0aec0' : '#2d3748',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? 'Filing…' : 'File Claim'}
            </button>
          </div>

        </form>
      </div>

    </div>
  );
}
