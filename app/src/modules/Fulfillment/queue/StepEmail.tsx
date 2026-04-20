import { useState } from 'react';
import {
  setStarterTracking,
  sendFulfillmentEmail,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export function StepEmail({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const [starter, setStarter] = useState(row.starter_tracking_num ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usOrder = order.country === 'US';
  const starterReady = !usOrder || starter.trim().length > 0;
  const canSend = starterReady && order.customer_email;

  const firstName = order.customer_name.split(' ')[0];
  const starterLine = usOrder ? `\nStarter kit · ${row.carrier}: ${starter || '<tbd>'}` : '';
  const preview =
    `Subject: Your LILA Pro has shipped! (${order.order_ref})\n` +
    `From: Team Lila <support@lilacomposter.com>\n` +
    `To: ${order.customer_email ?? '<no email>'}\n\n` +
    `Hi ${firstName},\n\n` +
    `Your LILA Pro is on the way. Here are your tracking details:\n\n` +
    `LILA Pro · ${row.carrier}: ${row.tracking_num}` + starterLine + `\n\n` +
    `Expected delivery in 3–7 business days.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    `Thanks for your order —\nTeam Lila\nsupport@lilacomposter.com`;

  const handleStarterBlur = async () => {
    if (starter === (row.starter_tracking_num ?? '') || !usOrder) return;
    try { await setStarterTracking(row.id, starter); }
    catch (e) { setError((e as Error).message); }
  };

  const handleSend = async () => {
    if (!canSend) return;
    setBusy(true); setError(null);
    // Make sure starter tracking is persisted before sending
    if (usOrder && starter !== (row.starter_tracking_num ?? '')) {
      try { await setStarterTracking(row.id, starter); }
      catch (e) { setError((e as Error).message); setBusy(false); return; }
    }
    try { await sendFulfillmentEmail(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Send the shipment-confirmation email</h3>
      {usOrder && (
        <>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)' }}>
            Starter-kit tracking number (required for US):
          </label>
          <input
            type="text"
            value={starter}
            onChange={e => setStarter(e.target.value)}
            onBlur={handleStarterBlur}
            placeholder="1Z… starter-kit tracking"
            style={{
              width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
              border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
              marginBottom: 10,
            }}
          />
        </>
      )}
      <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>Preview:</div>
      <pre style={{
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto',
      }}>{preview}</pre>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleSend} disabled={!canSend || busy}>
          {busy ? 'Sending…' : '✉ Send email'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
