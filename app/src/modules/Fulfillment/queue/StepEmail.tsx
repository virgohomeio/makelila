import { useState } from 'react';
import {
  sendFulfillmentEmail,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

function trackingUrl(carrier: string | null, tracking: string | null): string {
  if (!tracking) return 'https://www.ups.com/track?loc=en_US';
  switch (carrier) {
    case 'UPS':          return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
    case 'FedEx':        return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
    case 'Purolator':    return `https://www.purolator.com/en/shipping/tracker?pin=${encodeURIComponent(tracking)}`;
    case 'Canada Post':  return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${encodeURIComponent(tracking)}`;
    default:             return 'https://www.ups.com/track?loc=en_US';
  }
}

export function StepEmail({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = !!order.customer_email;

  const firstName = order.customer_name.split(' ')[0];
  const track = trackingUrl(row.carrier, row.tracking_num);
  const starterBlock = order.country === 'US' && row.starter_tracking_num
    ? `\nCompost Starter Kit (ships separately via Amazon)\n\n` +
      `Starter Tracking Number: ${row.starter_tracking_num}\n\n`
    : '';
  const preview =
    `Subject: Your LILA has officially shipped! 🎉 (${order.order_ref})\n` +
    `From: VCycene Team <support@lilacomposter.com>\n` +
    `To: ${order.customer_email ?? '<no email>'}\n\n` +
    `Hi ${firstName},\n\n` +
    `Your LILA has officially shipped! 🎉 It's on its way to you. Here are your shipping details:\n\n` +
    `Carrier: ${row.carrier ?? ''}\n\n` +
    `Tracking Number: ${row.tracking_num ?? ''}\n\n` +
    `Tracking Link: ${track}\n` +
    starterBlock + `\n` +
    `You can use the link above to check on your delivery progress at any time.\n\n` +
    `Important next steps\n\n` +
    `1. Mandatory onboarding session\n` +
    `Once your unit arrives, you'll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.\n` +
    `Book a session here: https://calendly.com/lila-ed.\n\n` +
    `2. Please keep the original box\n` +
    `Please do not throw out the original packaging for the first 30 days after delivery. In the rare event of shipping damage or if a return is required during our 30-day refund period, the unit must be returned in its original box.\n\n` +
    `Thank you again for being part of the LILA community and supporting our mission to make composting effortless and sustainable. We can't wait to see the difference your LILA will make in your home.\n\n` +
    `Happy Composting! 🌱\n` +
    `-The VCycene Team`;

  const handleSend = async () => {
    if (!canSend) return;
    setBusy(true); setError(null);
    try { await sendFulfillmentEmail(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Send the shipment-confirmation email</h3>
      <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>Preview:</div>
      <pre style={{
        background: 'var(--color-surface)', border: '1px solid var(--color-border)',
        padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto',
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
