import { useMemo, useState } from 'react';
import {
  buildEzTransBooking,
  sendEzTransBooking,
  useEzTransPlacement,
  EZTRANS_EMAIL,
  EZTRANS_SENT_ACTION,
  GOOROOSHIP_SHIP_URL,
  type EzTransShipTo,
} from '../../../lib/eztrans';
import { logAction, useActivityForEntity } from '../../../lib/activityLog';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export type EzTransOrder = EzTransShipTo & { id: string; order_ref: string };

/** The Goorooship half of step 3.
 *
 *  Stock on our own floor is booked through Freightcom. Stock held at the
 *  EZTrans 3PL is booked through Goorooship, and EZ Trans only picks the box
 *  once we email them a confirmation with a packing list — so this panel only
 *  renders when the unit assigned at step 1 is actually sitting at EZTrans.
 *  It renders nothing at all otherwise. */
export function EzTransPanel({ row, order }: { row: FulfillmentQueueRow; order: EzTransOrder }) {
  const { placement, loading } = useEzTransPlacement(row.assigned_serial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // "Already emailed" survives a reload, so an operator coming back to the row
  // doesn't double-book the 3PL. Logged against the order, which is where the
  // rest of this order's history lives.
  const { entries } = useActivityForEntity({ entityType: 'order', entityId: order.id, limit: 50 });
  const priorSend = entries.find(e => e.type === EZTRANS_SENT_ACTION) ?? null;

  const booking = useMemo(() => {
    if (!placement) return null;
    return buildEzTransBooking({
      order,
      serial: placement.serial,
      masterCarton: placement.masterCarton,
    });
  }, [order, placement]);

  if (loading || !placement || !booking) return null;

  const handleSend = async () => {
    setBusy(true); setError(null);
    try {
      await sendEzTransBooking(row.id);
      await logAction(
        EZTRANS_SENT_ACTION,
        order.order_ref,
        `Booking confirmation + packing list sent to ${EZTRANS_EMAIL} — ` +
        `serial ${placement.serial}, master carton ${placement.masterCarton ?? '—'}`,
        { entityType: 'order', entityId: order.id, unitSerial: placement.serial },
      );
      setJustSent(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sentAt = justSent ?? priorSend?.ts ?? null;

  return (
    <div className={styles.ezTransPanel}>
      <div className={styles.labelSectionHead}>EZ Trans shipment (Goorooship)</div>
      <p className={styles.ezTransLead}>
        {placement.serial} is held at EZ Trans
        {placement.skid ? ` on ${placement.skid}` : ''} — book this shipment on
        Goorooship, then send EZ Trans the confirmation so they can fulfill it.
      </p>

      <ol className={styles.ezTransSteps}>
        <li>
          <a
            href={GOOROOSHIP_SHIP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.extLinkBtn}
          >Goorooship — Book a shipment ↗</a>
          <span className={styles.ezTransHint}>Book it first — the email says it is already booked.</span>
        </li>
        <li>
          <button
            className={styles.confirmBtn}
            onClick={handleSend}
            disabled={busy}
          >
            {busy ? 'Sending…' : sentAt ? `✉ Resend to ${EZTRANS_EMAIL}` : `✉ Send confirmation to ${EZTRANS_EMAIL}`}
          </button>
          <button
            type="button"
            className={styles.ezTransPreviewToggle}
            onClick={() => setShowPreview(v => !v)}
          >{showPreview ? 'Hide preview' : 'Preview email + packing list'}</button>
        </li>
      </ol>

      <dl className={styles.ezTransFacts}>
        <div><dt>Serial No</dt><dd>{placement.serial}</dd></div>
        <div><dt>Master carton</dt><dd>{placement.masterCarton ?? '— (no pallet on record)'}</dd></div>
        <div><dt>Ship to</dt><dd>{order.customer_name}</dd></div>
      </dl>

      {sentAt && (
        <div className={styles.ezTransSent}>
          ✓ Confirmation sent to {EZTRANS_EMAIL} at {new Date(sentAt).toLocaleString()}.
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      {showPreview && (
        <>
          <div className={styles.ezTransPreviewLabel}>Email to {EZTRANS_EMAIL}:</div>
          <pre className={styles.ezTransPreview}>
            {`Subject: ${booking.subject}\n\n${booking.body}`}
          </pre>
          <div className={styles.ezTransPreviewLabel}>Attached packing list (PDF):</div>
          <pre className={styles.ezTransPreview}>{booking.packingList.join('\n')}</pre>
        </>
      )}
    </div>
  );
}
