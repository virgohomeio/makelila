import { useState } from 'react';
import {
  useAllClaims, useAllShipments,
  fileClaim, updateClaimStatus,
  type ClaimReason, type ClaimStatus,
} from '../../../lib/shipping';
import styles from '../Shipping.module.css';

const REASON_LABELS: Record<ClaimReason, string> = {
  damage: 'Damage',
  lost:   'Loss',
  late:   'Delay',
  other:  'Other',
};

function statusStyle(status: ClaimStatus): { background: string; color: string } {
  switch (status) {
    case 'open':      return { background: '#ebf8ff', color: '#2b6cb0' };
    case 'submitted': return { background: '#fefcbf', color: '#744210' };
    case 'resolved':  return { background: '#f0fff4', color: '#276749' };
    case 'denied':    return { background: '#fff5f5', color: '#c53030' };
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ClaimsTab() {
  const { claims, loading: claimsLoading, error: claimsError } = useAllClaims();
  const { shipments } = useAllShipments();

  const [formShipmentId, setFormShipmentId] = useState('');
  const [reason,     setReason]     = useState<ClaimReason>('damage');
  const [amount,     setAmount]     = useState('');
  const [notes,      setNotes]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState<string | null>(null);

  const selectedShipment = shipments.find(s => s.id === formShipmentId) ?? null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedShipment) { setSubmitErr('Select a shipment first.'); return; }
    setSubmitErr(null);
    setSubmitting(true);
    try {
      const amountCad = amount ? parseFloat(amount) : null;
      await fileClaim(selectedShipment.order_id, formShipmentId, reason, amountCad, notes.trim() || null);
      window.location.reload();
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : 'Failed to file claim');
      setSubmitting(false);
    }
  }

  async function handleStatusChange(claimId: string, orderId: string, status: ClaimStatus) {
    try {
      await updateClaimStatus(claimId, orderId, status);
      window.location.reload();
    } catch (err) {
      console.error('Failed to update claim status:', err);
    }
  }

  return (
    <div>
      {/* ── All Claims ──────────────────────────────────────────────── */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>All Claims</h3>

        {claimsLoading ? (
          <p style={{ color: '#718096', fontSize: 13 }}>Loading…</p>
        ) : claimsError ? (
          <p style={{ color: '#c53030', fontSize: 13 }}>{claimsError}</p>
        ) : claims.length === 0 ? (
          <p style={{ color: '#a0aec0', fontSize: 13 }}>No claims filed yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f7fafc' }}>
                <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Order</th>
                <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Filed</th>
                <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Type</th>
                <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Status</th>
                <th style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600 }}>Amount</th>
                <th style={{ padding: '7px 12px', textAlign: 'left',  fontWeight: 600 }}>Notes</th>
                <th style={{ padding: '7px 12px' }}></th>
              </tr>
            </thead>
            <tbody>
              {claims.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '7px 12px', fontWeight: 600, fontSize: 12 }}>{c.order_ref || '—'}</td>
                  <td style={{ padding: '7px 12px', color: '#4a5568' }}>{formatDate(c.filed_at)}</td>
                  <td style={{ padding: '7px 12px' }}>{REASON_LABELS[c.reason] ?? c.reason}</td>
                  <td style={{ padding: '7px 12px' }}>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                      fontSize: 11, fontWeight: 600, ...statusStyle(c.status),
                    }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                    {c.amount_cad != null ? `$${c.amount_cad.toFixed(2)} CAD` : '—'}
                  </td>
                  <td style={{ padding: '7px 12px', color: '#718096', maxWidth: 240,
                               whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.notes ?? '—'}
                  </td>
                  <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                    {(c.status === 'open' || c.status === 'submitted') && (
                      <select
                        value={c.status}
                        onChange={e => handleStatusChange(c.id, c.order_id, e.target.value as ClaimStatus)}
                        style={{ fontSize: 12, padding: '3px 6px', border: '1px solid #e2e8f0', borderRadius: 3 }}
                      >
                        <option value="open">Open</option>
                        <option value="submitted">Submitted</option>
                        <option value="resolved">Resolved</option>
                        <option value="denied">Denied</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── File a New Claim ─────────────────────────────────────────── */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>File a New Claim</h3>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420 }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#4a5568' }}>Shipment</label>
            <select
              value={formShipmentId}
              onChange={e => { setFormShipmentId(e.target.value); setSubmitErr(null); }}
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4, background: '#fff' }}
            >
              <option value="">— Select shipment —</option>
              {shipments.map(s => (
                <option key={s.id} value={s.id}>
                  {s.order_ref} — {s.customer_name} ({s.carrier})
                </option>
              ))}
            </select>
          </div>

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
              type="number" min="0" step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4 }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#4a5568' }}>
              Notes <span style={{ fontWeight: 400, color: '#a0aec0' }}>(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Describe the damage, loss, or delay…"
              style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 4,
                       resize: 'vertical', fontFamily: 'inherit' }}
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
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                background: submitting ? '#a0aec0' : '#2d3748',
                color: '#fff', border: 'none', borderRadius: 4,
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
