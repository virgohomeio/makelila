import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { setSalesConfirmedFit, verifyAddress } from '../../../lib/orders';
import { sendTemplate } from '../../../lib/templates';
import styles from '../OrderReview.module.css';

const VERDICT_CLASS: Record<Order['address_verdict'], string> = {
  house:  styles.verdictHouse,
  apt:    styles.verdictApt,
  condo:  styles.verdictCondo,
  remote: styles.verdictRemote,
};

const VERDICT_LABEL: Record<Order['address_verdict'], string> = {
  house:  'Single-family · standard delivery',
  apt:    'Apartment · delivery may need coordination',
  condo:  'Condo · concierge / dock concerns',
  remote: 'Remote area · freight surcharge likely',
};

function MissingField() {
  return <span className={styles.missing}>Missing — complete via QUO</span>;
}

export function AddressCard({ order }: { order: Order }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runVerify = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await verifyAddress(order.id);
      setMsg(
        r.match === 'match'      ? 'Address verified.' :
        r.match === 'mismatch'   ? 'Postal code mismatch — see below.' :
                                   'Could not verify.'
      );
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendMismatchEmail = async () => {
    if (!order.customer_email) { setMsg('No customer email on file.'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await sendTemplate({
        template_key: 'address_mismatch',
        to: order.customer_email,
        to_name: order.customer_name,
        variables: {
          customer_first_name:  order.customer_name.split(' ')[0],
          address_we_have:      order.address_line ?? '',
          address_standardized: order.address_google_formatted ?? '',
          order_ref:            order.order_ref,
        },
      });
      setMsg(`✓ Email sent (id ${r.message_id})`);
    } catch (e) {
      setMsg(`Send failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Shipping Address</div>
      <div className={styles.cardBody}>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Street</span>
          {order.address_line
            ? <span>{order.address_line}</span>
            : <MissingField />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>City</span>
          <span>{order.city}</span>
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Region</span>
          {order.region_state
            ? <span>{order.region_state}</span>
            : <MissingField />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>{order.country === 'US' ? 'ZIP Code' : 'Postal Code'}</span>
          {order.address_customer_postal
            ? <span>{order.address_customer_postal}</span>
            : <MissingField />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Country</span>
          <span>{order.country}</span>
        </div>

        <div className={`${styles.verdict} ${VERDICT_CLASS[order.address_verdict]}`} style={{ marginTop: 12 }}>
          <strong>{order.address_verdict.toUpperCase()}</strong>
          <span>{VERDICT_LABEL[order.address_verdict]}</span>
        </div>

        {order.address_verdict !== 'house' && (
          <div className={styles.salesConfirmToggle}>
            <input
              type="checkbox"
              id={`sales-fit-${order.id}`}
              checked={order.sales_confirmed_fit}
              onChange={async e => {
                try { await setSalesConfirmedFit(order.id, e.target.checked); }
                catch (err) { alert((err as Error).message); }
              }}
            />
            <label htmlFor={`sales-fit-${order.id}`}>
              Sales confirmed fit with customer (required for {order.address_verdict} addresses)
            </label>
          </div>
        )}

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => void runVerify()}
              disabled={busy}
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 600,
                background: order.address_verified_at ? '#fff' : 'var(--color-crimson)',
                color: order.address_verified_at ? 'var(--color-ink-muted)' : '#fff',
                border: '1px solid ' + (order.address_verified_at ? 'var(--color-border)' : 'var(--color-crimson)'),
                borderRadius: 'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy ? 'Verifying…' : order.address_verified_at ? 'Re-verify' : 'Verify address'}
            </button>

            {order.address_match === 'match' && (
              <span style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4,
                background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', fontWeight: 700,
                letterSpacing: 0.3,
              }}>✓ MATCH</span>
            )}
            {order.address_match === 'mismatch' && (
              <span style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4,
                background: '#fff5f5', color: '#9b2c2c', border: '1px solid #fc8181', fontWeight: 700,
                letterSpacing: 0.3,
              }}>⚠ POSTAL MISMATCH</span>
            )}
            {order.address_match === 'unverifiable' && (
              <span style={{
                fontSize: 10, padding: '3px 8px', borderRadius: 4,
                background: '#fffaf0', color: '#c05621', border: '1px solid #fbd38d', fontWeight: 700,
                letterSpacing: 0.3,
              }}>UNVERIFIABLE</span>
            )}
            {order.address_claude_verdict && (
              <span
                title={order.address_claude_notes ?? ''}
                style={{
                  fontSize: 10, padding: '3px 8px', borderRadius: 4,
                  background: '#ebf8ff', color: '#2c5282', border: '1px solid #90cdf4',
                  fontWeight: 700, letterSpacing: 0.3,
                }}
              >via Claude: {order.address_claude_verdict}</span>
            )}
          </div>

          {order.address_claude_notes && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-ink-muted)', fontStyle: 'italic' }}>
              Claude: {order.address_claude_notes}
              {order.address_claude_postal && (
                <> · inferred postal: <strong>{order.address_claude_postal}</strong></>
              )}
            </div>
          )}

          {order.address_match === 'mismatch' && order.address_google_formatted && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-ink-muted)' }}>
              <div>Customer ZIP: <strong>{order.address_customer_postal ?? '—'}</strong></div>
              <div>Google ZIP: <strong>{order.address_google_postal ?? '—'}</strong></div>
              <div style={{ marginTop: 4 }}>Google's address: <em>{order.address_google_formatted}</em></div>
              <button
                onClick={() => void sendMismatchEmail()}
                disabled={busy || !order.customer_email}
                style={{
                  marginTop: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600,
                  background: 'var(--color-crimson)', color: '#fff', border: 'none',
                  borderRadius: 'var(--radius-sm)', cursor: (busy || !order.customer_email) ? 'not-allowed' : 'pointer',
                  opacity: !order.customer_email ? 0.5 : 1,
                }}
              >
                Send mismatch email
              </button>
            </div>
          )}

          {msg && (
            <div style={{
              marginTop: 8, fontSize: 11,
              color: msg.startsWith('Error') || msg.startsWith('Send failed') || msg.startsWith('No customer') ? 'var(--color-error, #c53030)' : 'var(--color-ink-muted)',
            }}>
              {msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
