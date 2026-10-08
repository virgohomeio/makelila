import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { freightcomBookingConfirmed, FREIGHTCOM_SHIP_URL } from '../../../lib/freightcomBooking';
import { QUEUE_CARRIERS } from '../../../lib/queueCarrier';
import { starterBlocker } from '../../../lib/starterKit';
import { EzTransPanel, type EzTransOrder } from './EzTransPanel';
import { FreightcomPanel } from './FreightcomPanel';
import { StepStarterKit, type StarterSkip } from './StepStarterKit';
import { StepBlockers } from './StepBlockers';
import styles from '../Fulfillment.module.css';

export function StepLabel({
  row,
  order,
  isEzTrans = false,
  goorooshipSentAt = null,
  onBatchChanged,
}: {
  row: FulfillmentQueueRow;
  /** The whole order: the EZ Trans packing list needs the customer's full
   *  name, address, email and phone, not just the country, and `kind` decides
   *  whether a bag of starter soil is owed at all. */
  order: EzTransOrder & { kind: 'sale' | 'replacement' };
  /** Is a machine on this order held at the EZ Trans 3PL? It decides which of
   *  the two booking panels this step shows, and what the last gate on the
   *  button is: an EZ Trans carton waits on the Goorooship email to the 3PL, a
   *  Freightcom one on its own booking being confirmed. Defaults to false, so
   *  a caller that cannot answer (or an order with no machine on it at all)
   *  gets the Freightcom path. */
  isEzTrans?: boolean;
  /** When the Goorooship email carrying this order went out, null if it has
   *  not. Read off the queue's own index of sends (lib/pickupQueue.ts) rather
   *  than re-derived here, so the gate on this button and the rail the row
   *  lands in are answering out of one place. */
  goorooshipSentAt?: string | null;
  /** Passed through to the EZ Trans panel: confirming an order into the day's
   *  Goorooship batch has to reach the footer at the bottom of the queue. */
  onBatchChanged?: () => void;
}) {
  // Seeded from the row so a label already attached — by either booking panel
  // below, or on an earlier pass that was rewound — doesn't have to be typed
  // in twice. This component is keyed on the row id by the queue, so the seed
  // is this row's and cannot follow the operator to the next one they click.
  const [carrier, setCarrier] = useState<string>(row.carrier ?? '');
  const [tracking, setTracking] = useState<string>(row.tracking_num ?? '');
  const [starterTracking, setStarterTracking] = useState<string>(row.starter_tracking_num ?? '');
  // The other answer the starter card can give: this order ships no soil, and
  // here is why. Held here rather than in the card so the gate below and the
  // card are reading one value — a card with its own copy could leave the step
  // shut after the operator had already answered it.
  const [starterSkip, setStarterSkip] = useState<StarterSkip | null>(
    row.starter_skipped_at
      ? { at: row.starter_skipped_at, reason: row.starter_skip_reason ?? '' }
      : null,
  );
  // Whether the Freightcom booking is on the record. Seeded from the row and
  // moved locally when the panel confirms, rather than waited for over
  // realtime: a gate that needs a socket round-trip to open reads as the app
  // refusing work the operator has just finished.
  const [freightcomConfirmed, setFreightcomConfirmed] = useState(
    () => freightcomBookingConfirmed(row),
  );
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Four gates, whichever carrier the order books with.
  //
  // The carrier and the tracking number are the shipment itself. The compost
  // starter is the third: every machine sale ships a bag of soil bought on
  // Amazon, and asking for its tracking number only as an optional US-only
  // extra meant it got ordered when somebody remembered — three of 63 US rows
  // had a number on 2026-10-07, and no CA row could have had one at all. It is
  // demanded here because here is the last moment it can be: the carton goes
  // out next.
  //
  // This gate stranded orders once before, when it keyed on country alone and
  // an order with no starter kit had no number to paste (5a01566). It cannot
  // again: a replacement is exempt in code, and any other order can be let
  // through by an operator saying in writing why there is no soil on it. The
  // step is never shut against work that is actually finished.
  //
  // The fourth gate is the booking, and until 2026-10-08 only half the orders
  // had one. On an EZ Trans order it is the Goorooship email: this button is
  // what books the pickup — it moves the row to the dock handoff and into "To
  // be picked up", which says to everyone reading the queue that the carton is
  // with the 3PL and the carrier is coming for it. EZ Trans does not touch a
  // box they have not been emailed about, so clicking it before the booking
  // email goes out puts a carton in that rail that nobody is coming to
  // collect.
  //
  // On a Freightcom order it is the booking panel's own confirm, which is the
  // same statement about the same facts: the shipment is booked on the portal,
  // and the carrier, the tracking number and the label PDF it issued are on
  // the row. That last one is why the gate exists. The label was an optional
  // field on a bare card before this, and optional meant empty — 28 of the 111
  // rows this queue has carried to step 6 have a label on them, and 12 of
  // those 28 are EZ Trans rows, the only ones where it was ever demanded. A
  // box that goes missing with no label on file leaves the carrier's copy as
  // the only copy.
  const blockers: string[] = [];
  if (!carrier) blockers.push('a carrier');
  if (!tracking.trim()) {
    blockers.push(isEzTrans ? 'the Goorooship tracking number' : 'the Freightcom tracking number');
  }
  const starterGap = starterBlocker(order, {
    starter_tracking_num: starterTracking,
    starter_skipped_at: starterSkip?.at ?? null,
  });
  if (starterGap) blockers.push(starterGap);
  const awaitingGoorooship = isEzTrans && !goorooshipSentAt;
  if (awaitingGoorooship) blockers.push('the Goorooship email to EZ Trans to go out');
  const awaitingFreightcom = !isEzTrans && !freightcomConfirmed;
  if (awaitingFreightcom) blockers.push('the Freightcom booking to be confirmed');
  const ready = blockers.length === 0;

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
        // Saved whatever the destination: starter soil was never a US-only
        // product, only a US-only field.
        ...(starterTracking.trim() ? { starter_tracking_num: starterTracking.trim() } : {}),
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Attach the shipping label details</h3>

      {/* Above the booking panels on purpose. It gates both of them — the
          Goorooship email as much as the Freightcom confirm — so a card the
          operator has to scroll past the disabled buttons to find would read
          as the app being broken rather than as work still to do. Renders
          nothing on a replacement. */}
      <StepStarterKit
        queueId={row.id}
        order={order}
        tracking={starterTracking}
        onTrackingChange={setStarterTracking}
        skip={starterSkip}
        onSkipChange={setStarterSkip}
      />

      {/* One booking panel per order, picked by where the stock is sitting.
          Both are the same four moves — open the carrier's portal, book it,
          record the label it issued, confirm — and both hand the carrier and
          tracking number back up here so this step closes in one click. */}
      {isEzTrans ? (
        <EzTransPanel
          row={row}
          order={order}
          onLabelSaved={({ carrier: c, tracking_num: t }) => { setCarrier(c); setTracking(t); }}
          onBatchChanged={onBatchChanged}
          starterGap={starterGap}
        />
      ) : (
        <FreightcomPanel
          row={row}
          order={order}
          onLabelSaved={({ carrier: c, tracking_num: t }) => { setCarrier(c); setTracking(t); }}
          onConfirmed={() => setFreightcomConfirmed(true)}
          starterGap={starterGap}
        />
      )}

      {/* The EZ Trans panel renders nothing while it is still resolving where
          the machines are, and nothing at all if that lookup fails — so the
          plain fields stay available on an EZ Trans order as the way out of
          that. A Freightcom order has no such hole: its panel always renders,
          and owns these three fields outright. */}
      {isEzTrans && (
        <>
          <div style={{
            background: 'var(--color-info-bg)',
            border: '1px solid var(--color-info-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 12px',
            marginBottom: 14,
            fontSize: 11,
            color: 'var(--color-info)',
            display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <a
              href={FREIGHTCOM_SHIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >Freightcom — New Shipment ↗</a>
            <span style={{ marginLeft: 'auto', color: 'var(--color-info)' }}>
              compost starter ships via Amazon
            </span>
          </div>

          <div className={styles.labelSection}>
            <div className={styles.labelSectionHead}>Label details</div>

            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 4 }}>
              Carrier:
            </label>
            <select
              value={carrier}
              onChange={e => setCarrier(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4 }}
            >
              <option value="">— select —</option>
              {QUEUE_CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
              Tracking number:
            </label>
            <input
              type="text"
              value={tracking}
              onChange={e => setTracking(e.target.value)}
              placeholder="1Z… / paste from the label"
              style={{
                width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
                border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
              }}
            />

            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
              Label PDF (optional):
            </label>
            {pdf ? (
              <div style={{ fontSize: 11, color: 'var(--color-ink)', marginTop: 3 }}>
                {pdf.name} · {(pdf.size / 1024).toFixed(0)} KB
                <button
                  onClick={() => setPdf(null)}
                  style={{
                    marginLeft: 8, background: 'transparent', border: '1px solid var(--color-border)',
                    color: 'var(--color-ink-subtle)', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
                  }}
                >Remove</button>
              </div>
            ) : (
              <>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={e => setPdf(e.target.files?.[0] ?? null)}
                  style={{ fontSize: 11 }}
                />
                {row.label_pdf_path && (
                  <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginTop: 3 }}>
                    A label is already on this order — pick a file only to replace it.
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!ready || busy}>
          {busy ? 'Saving…' : '✓ Pickup scheduled'}
        </button>
        <StepBlockers blockers={blockers} />
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
