import { useState } from 'react';
import {
  confirmFreightcomBooking,
  freightcomBookingConfirmed,
  FREIGHTCOM_SHIP_URL,
  type FreightcomPackage,
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
  row: FulfillmentQueueRow & { extra_packages?: FreightcomPackage[] | null };
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
  const serials = row.assigned_serials ?? [];
  const [carrier, setCarrier] = useState(row.carrier ?? '');
  // One entry per box — Freightcom issues a label and a tracking number for
  // each. Box 1 is the row's own tracking_num / label_pdf_path; boxes 2..N
  // live in extra_packages. Starts at one box; a multi-machine order gets a
  // nudge below to add the rest rather than a forced count, since a pallet
  // booking (Day & Ross) can carry several machines on one label.
  const [boxes, setBoxes] = useState<Box[]>(() => initialBoxes(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The local echo of a confirm, so the operator gets an answer before the
  // realtime round-trip brings the row back. StepLabel keys this panel on the
  // row id, so it cannot follow them to the next order they click.
  const [justConfirmed, setJustConfirmed] = useState<string | null>(null);

  // A label uploaded on an earlier pass is already on the row, so a correction
  // — a re-keyed tracking number, a different carrier — doesn't send the
  // operator looking for the file again.
  const confirmed = !!justConfirmed || freightcomBookingConfirmed(row);
  const multi = boxes.length > 1;

  const boxReady = (b: Box) => !!b.tracking.trim() && (!!b.pdf || !!b.pathOnFile);
  const ready = !!carrier && boxes.every(boxReady) && !starterGap;

  const updateBox = (i: number, patch: Partial<Box>) =>
    setBoxes(bs => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const addBox = () => setBoxes(bs => [...bs, emptyBox()]);
  const removeBox = (i: number) => setBoxes(bs => (bs.length > 1 ? bs.filter((_, j) => j !== i) : bs));

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    const [first, ...rest] = boxes;
    try {
      const saved = await confirmFreightcomBooking(row.id, {
        carrier,
        tracking_num: first.tracking.trim(),
        ...(first.pdf ? { label_pdf: first.pdf } : {}),
        // Always sent, so removing a box here removes it from the record.
        // Skipped only when the row never had extras and still has none, so
        // a single-box confirm does not depend on the extra_packages column.
        ...(rest.length || (row.extra_packages?.length ?? 0) > 0
          ? {
              extra_packages: rest.map(b => ({
                tracking_num: b.tracking.trim(),
                label_pdf: b.pdf,
                label_pdf_path: b.pathOnFile,
              })),
            }
          : {}),
        order: { id: order.id, order_ref: order.order_ref },
        serials,
      });
      onLabelSaved?.({ carrier, tracking_num: first.tracking.trim() });
      // The new files are on the record now; keep the fields, drop the picks.
      setBoxes(bs => bs.map((b, i) => ({
        ...b,
        pdf: null,
        pathOnFile: i === 0
          ? (saved.label_pdf_path ?? b.pathOnFile)
          : (saved.extra_packages?.[i - 1]?.label_pdf_path ?? b.pathOnFile),
      })));
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

            {boxes.map((b, i) => (
              <fieldset
                key={b.key}
                className={multi ? styles.bookingBox : styles.bookingBoxSingle}
                data-testid={`freightcom-box-${i + 1}`}
              >
                {multi && (
                  <legend>
                    Box {i + 1} of {boxes.length}
                    <button
                      type="button"
                      onClick={() => removeBox(i)}
                      data-testid={`freightcom-remove-box-${i + 1}`}
                    >Remove box</button>
                  </legend>
                )}
                <label>
                  Tracking number:
                  <input
                    type="text"
                    value={b.tracking}
                    onChange={e => updateBox(i, { tracking: e.target.value })}
                    placeholder="Paste from the Freightcom label"
                    data-testid={i === 0 ? 'freightcom-tracking' : `freightcom-tracking-${i + 1}`}
                  />
                </label>

                <label>
                  Shipping label PDF:
                  {b.pdf ? (
                    <span className={styles.bookingFile}>
                      {b.pdf.name} · {(b.pdf.size / 1024).toFixed(0)} KB
                      <button type="button" onClick={() => updateBox(i, { pdf: null })}>Remove</button>
                    </span>
                  ) : (
                    <input
                      type="file"
                      accept="application/pdf"
                      onChange={e => updateBox(i, { pdf: e.target.files?.[0] ?? null })}
                      data-testid={i === 0 ? 'freightcom-label-pdf' : `freightcom-label-pdf-${i + 1}`}
                    />
                  )}
                </label>
                {b.pathOnFile && !b.pdf && (
                  <span className={styles.bookingHint}>
                    A label is already on file for this box — pick a file only to replace it.
                  </span>
                )}
              </fieldset>
            ))}
            {serials.length > boxes.length && (
              <span className={styles.bookingHint} data-testid="freightcom-box-nudge">
                {serials.length} machines, {boxes.length} {boxes.length === 1 ? 'label' : 'labels'} —
                if Freightcom issued a label per box, add a box for each so every
                tracking number and label is on the record.
              </span>
            )}
            <button
              type="button"
              className={styles.bookingAddBox}
              onClick={addBox}
              data-testid="freightcom-add-box"
            >+ Add another box</button>
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
                {multi
                  ? 'Carrier, plus a tracking number and label PDF for every box, are required before this booking can be confirmed.'
                  : 'Carrier, tracking number and the label PDF are all required before this booking can be confirmed.'}
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
              {' '}{carrier} {boxes.map(b => b.tracking.trim()).join(', ')},
              {multi ? ` ${boxes.length} labels on file.` : ' label on file.'}
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

type Box = {
  key: string;
  tracking: string;
  pdf: File | null;
  /** Set when this box already has a label in storage. */
  pathOnFile: string | null;
};

let boxSeq = 0;
function emptyBox(): Box {
  return { key: `box-${++boxSeq}`, tracking: '', pdf: null, pathOnFile: null };
}

function initialBoxes(
  row: FulfillmentQueueRow & { extra_packages?: FreightcomPackage[] | null },
): Box[] {
  const first: Box = {
    ...emptyBox(),
    tracking: row.tracking_num ?? '',
    pathOnFile: row.label_pdf_path ?? null,
  };
  const extras = Array.isArray(row.extra_packages) ? row.extra_packages : [];
  if (extras.length) {
    return [first, ...extras.map(p => ({
      ...emptyBox(),
      tracking: p.tracking_num ?? '',
      pathOnFile: p.label_pdf_path || null,
    }))];
  }
  return [first];
}
