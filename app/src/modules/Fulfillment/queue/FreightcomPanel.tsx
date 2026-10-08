import { useState } from 'react';
import {
  confirmFreightcomBooking,
  freightcomBookingConfirmed,
  FREIGHTCOM_SHIP_URL,
} from '../../../lib/freightcomBooking';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import { QUEUE_CARRIERS } from '../../../lib/queueCarrier';
import styles from '../Fulfillment.module.css';
import type { EzTransOrder } from './EzTransPanel';


/** The Freightcom half of step 3 — the booking panel for stock on our own floor.
 *
 *  The sibling of EzTransPanel, and deliberately the same four moves in the
 *  same order: open the carrier's portal, book the shipment there, record the
 *  label the portal issued, confirm it. Only then does "Pickup scheduled"
 *  below open.
 *
 *  It replaces a bare card that asked for a carrier and a tracking number and
 *  offered the label PDF as "(optional)". Two differences matter:
 *
 *    - the label PDF is required, as it is on the Goorooship side. It was the
 *      optional field nobody filled — 28 of 111 rows that reached step 6 have
 *      a label on them, 12 of those being EZ Trans rows, the ones where it was
 *      demanded. A Freightcom shipment that goes missing with no label on file
 *      leaves the carrier's own copy as the only copy.
 *    - confirming is its own move, and it writes a line to the order's
 *      history. Before this, a Freightcom booking left no trace saying it had
 *      been made: typing two fields and clicking "Pickup scheduled" was one
 *      gesture, and `fq_label_confirmed` recorded the step advance rather than
 *      the booking.
 *
 *  Nothing here books anything. The shipment is made on the Freightcom portal,
 *  exactly as the Goorooship one is made on Goorooship's — see
 *  lib/freightcomBooking.ts. */
export function FreightcomPanel({
  row,
  order,
  onLabelSaved,
  onConfirmed,
  starterGap = null,
}: {
  row: FulfillmentQueueRow;
  order: EzTransOrder;
  /** Hands the saved carrier and tracking number up to StepLabel, so
   *  "Pickup scheduled" is a single click after a confirm rather than the same
   *  two fields typed again. The Goorooship panel feeds it the same way. */
  onLabelSaved?: (v: { carrier: string; tracking_num: string }) => void;
  /** Fired once the booking is on the record. StepLabel holds that answer
   *  itself rather than re-reading the row for it: the label path only comes
   *  back over realtime, and the last gate on "Pickup scheduled" must not wait
   *  on a socket to notice work the operator has just finished. */
  onConfirmed?: () => void;
  /** What the compost starter is still waiting on, null when nothing. Computed
   *  by StepLabel so the confirm here and "Pickup scheduled" below are gated
   *  by one answer rather than two — the soil has to be ordered before the
   *  carton leaves, and this is the last moment anyone looks at the order. */
  starterGap?: string | null;
}) {
  const [carrier, setCarrier] = useState(row.carrier ?? '');
  const [tracking, setTracking] = useState(row.tracking_num ?? '');
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The local echo of a confirm, so the operator gets an answer before the
  // realtime round-trip brings the row back. StepLabel keys this panel on the
  // row id, so it cannot follow them to the next order they click.
  const [justConfirmed, setJustConfirmed] = useState<string | null>(null);

  // A label uploaded on an earlier pass is already on the row, so a correction
  // — a re-keyed tracking number, a different carrier — doesn't send the
  // operator looking for the file again.
  const labelOnFile = !!row.label_pdf_path;
  const confirmed = !!justConfirmed || freightcomBookingConfirmed(row);

  const ready = !!carrier && !!tracking.trim() && (!!pdf || labelOnFile) && !starterGap;

  const serials = row.assigned_serials ?? [];

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmFreightcomBooking(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
        order: { id: order.id, order_ref: order.order_ref },
        serials,
      });
      onLabelSaved?.({ carrier, tracking_num: tracking.trim() });
      setPdf(null);
      setJustConfirmed(new Date().toISOString());
      onConfirmed?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.bookingPanel} data-testid="freightcom-panel">
      <div className={styles.labelSectionHead}>LILA shipment (Freightcom)</div>
      <p className={styles.bookingLead}>
        {serials.length === 1
          ? `${serials[0]} ships`
          : serials.length > 1
            ? `${serials.length} machines ship`
            : 'This order ships'} off our own floor — book it on Freightcom,
        attach the label Freightcom issues, then confirm it so our record
        carries the same label the carrier does.
      </p>

      <ol className={styles.bookingSteps}>
        <li>
          <div className={styles.bookingStepRow}>
            <a
              href={FREIGHTCOM_SHIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >Freightcom — New Shipment ↗</a>
            <span className={styles.bookingHint}>
              Book it first — confirming below records a shipment that already exists.
            </span>
          </div>
        </li>

        <li>
          <span className={styles.bookingStepTitle}>Attach the label Freightcom issued</span>
          <div className={styles.bookingForm}>
            <label>
              Carrier:
              <select
                value={carrier}
                onChange={e => setCarrier(e.target.value)}
                data-testid="freightcom-carrier"
              >
                <option value="">— select —</option>
                {QUEUE_CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label>
              Tracking number:
              <input
                type="text"
                value={tracking}
                onChange={e => setTracking(e.target.value)}
                placeholder="Paste from the Freightcom label"
                data-testid="freightcom-tracking"
              />
            </label>

            <label>
              Shipping label PDF:
              {pdf ? (
                <span className={styles.bookingFile}>
                  {pdf.name} · {(pdf.size / 1024).toFixed(0)} KB
                  <button type="button" onClick={() => setPdf(null)}>Remove</button>
                </span>
              ) : (
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={e => setPdf(e.target.files?.[0] ?? null)}
                  data-testid="freightcom-label-pdf"
                />
              )}
            </label>
            {labelOnFile && !pdf && (
              <span className={styles.bookingHint}>
                A label is already on this order — pick a file only to replace it.
              </span>
            )}
          </div>
        </li>

        <li>
          <span className={styles.bookingStepTitle}>Confirm the booking</span>
          <div className={styles.bookingStepRow}>
            <button
              className={styles.confirmBtn}
              onClick={handleConfirm}
              disabled={!ready || busy}
              data-testid="freightcom-confirm"
            >
              {busy
                ? 'Saving…'
                : confirmed
                  ? '✓ Update this booking'
                  : '✓ Confirm carrier, tracking + label'}
            </button>
            {starterGap ? (
              <span className={styles.bookingHint}>
                The compost starter comes first — order it and paste the Amazon
                tracking number in the card above. Once the carton is on the
                dock there is no adding a starter to it.
              </span>
            ) : !ready ? (
              <span className={styles.bookingHint}>
                Carrier, tracking number and the label PDF are all required before this
                booking can be confirmed.
              </span>
            ) : (
              <span className={styles.bookingHint}>
                Confirming puts the booking on this order's record. Say the carrier has
                collected it with Pickup scheduled, below.
              </span>
            )}
          </div>

          {confirmed && (
            <div className={styles.bookingSent} data-testid="freightcom-confirmed">
              ✓ Freightcom booking confirmed
              {justConfirmed ? ` at ${new Date(justConfirmed).toLocaleString()}` : ''} —
              {/* The fields, not the row. They are seeded from the row on mount
                  and hold whatever was last saved, so a corrected tracking
                  number reads back as the corrected one; the row only catches
                  up over realtime, and echoing it would show the operator the
                  number they had just replaced. */}
              {' '}{carrier} {tracking.trim()}, label on file.
              Confirm again only to correct it.
            </div>
          )}
        </li>
      </ol>

      <dl className={styles.bookingFacts}>
        {serials.length > 0 && (
          <div>
            <dt>{serials.length === 1 ? 'Serial No' : `Serial Nos (${serials.length})`}</dt>
            <dd>{serials.map(s => <div key={s}>{s}</div>)}</dd>
          </div>
        )}
        <div><dt>Quantity</dt><dd>{serials.length || '—'}</dd></div>
        <div><dt>Ship to</dt><dd>{order.customer_name}</dd></div>
      </dl>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
