import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { freightcomBookingConfirmed, useFreightcomBooked } from '../../../lib/freightcomBooking';
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
  // Set when the Freightcom panel confirms in this session, so the gate opens
  // without waiting on a socket round-trip — a gate that needs realtime to
  // notice reads as the app refusing work the operator has just finished.
  const [justBookedFreightcom, setJustBookedFreightcom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which carrier this carton is actually going out with.
  //
  // Where the stock sits is a good guess and not the answer. A machine at the
  // EZ Trans 3PL usually books through Goorooship, but not always — #1258 went
  // out on Canpar booked in the Freightcom portal while its unit sat at EZ
  // Trans — and an operator who has done that has no way to say so if the step
  // reads the shelf instead of asking them.
  //
  // (The evidence said otherwise, and the evidence was wrong: the `shipments`
  // table only holds bookings made through the Freightcom API, so a portal
  // booking leaves no row there and looked like no Freightcom shipment at all.)
  //
  // So the guess seeds it and the operator overrides it. The override survives
  // a reload because confirming a Freightcom booking writes a line to the
  // order's history, and that line is read back here — no column, no
  // migration, and a rebook retires it along with the booking it describes.
  const { booked: freightcomBooked, loading: bookedLoading } = useFreightcomBooked(order.id);
  const [routeOverride, setRouteOverride] = useState<'goorooship' | 'freightcom' | null>(null);
  const route: 'goorooship' | 'freightcom' =
    routeOverride
    ?? (freightcomBooked || justBookedFreightcom ? 'freightcom'
        : isEzTrans ? 'goorooship'
        : 'freightcom');

  // Is the Freightcom booking on the record?
  //
  // Not simply "the row has a carrier, a tracking number and a label on it".
  // The Goorooship panel writes those same three columns, so on an EZ Trans
  // order they are equally consistent with a Goorooship booking — reading the
  // row alone would let an operator fill the Goorooship panel, flip the route
  // to Freightcom and find the gate already open on a booking nobody made.
  // There, only the log line (or a confirm in this session) is proof.
  //
  // On an own-floor order the Freightcom panel is the only thing that writes
  // those columns, so the row IS the proof — which also means the rows that
  // reached step 3 before this log line existed are not stranded by it.
  const freightcomConfirmed =
    justBookedFreightcom || freightcomBooked || (!isEzTrans && freightcomBookingConfirmed(row));

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
    blockers.push(route === 'goorooship' ? 'the Goorooship tracking number' : 'the Freightcom tracking number');
  }
  const starterGap = starterBlocker(order, {
    starter_tracking_num: starterTracking,
    starter_skipped_at: starterSkip?.at ?? null,
  });
  if (starterGap) blockers.push(starterGap);
  const awaitingGoorooship = route === 'goorooship' && !goorooshipSentAt;
  if (awaitingGoorooship) blockers.push('the Goorooship email to EZ Trans to go out');
  const awaitingFreightcom = route === 'freightcom' && !freightcomConfirmed;
  if (awaitingFreightcom) blockers.push('the Freightcom booking to be confirmed');
  const ready = blockers.length === 0;

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
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

      {/* Which carrier, asked rather than assumed.
          Only offered when the stock is at the 3PL, because that is the only
          case with two real answers: a machine on our own floor cannot be
          booked through Goorooship at all. */}
      {isEzTrans && (
        <div className={styles.routePicker} data-testid="carrier-route">
          <span className={styles.routePickerLabel}>Booked through:</span>
          <button
            type="button"
            className={route === 'goorooship' ? styles.routeBtnOn : styles.routeBtn}
            onClick={() => setRouteOverride('goorooship')}
            data-testid="route-goorooship"
          >Goorooship (EZ Trans)</button>
          <button
            type="button"
            className={route === 'freightcom' ? styles.routeBtnOn : styles.routeBtn}
            onClick={() => setRouteOverride('freightcom')}
            data-testid="route-freightcom"
          >Freightcom</button>
          <span className={styles.bookingHint}>
            {route === 'freightcom'
              ? 'Booked in the Freightcom portal. EZ Trans still hold the machine, '
                + 'so the handoff email is queued below as usual.'
              : 'Switch to Freightcom if you booked this one in the Freightcom portal.'}
          </span>
        </div>
      )}

      {/* The booking panel: whichever portal issued the label owns the three
          fields that describe it, and only that one renders them.

          There used to be a second copy below the Goorooship panel — a plain
          card that looked like the place to type the carrier, the tracking
          number and the label, and was not, because the panel reads its own
          copy. #1258 had a Canpar number and a label sitting in that card
          while the panel above said all three were still required and the
          step stayed shut. Two sets of one field is a decoy, not a fallback. */}
      {route === 'goorooship' ? (
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
          onConfirmed={() => setJustBookedFreightcom(true)}
          starterGap={starterGap}
        />
      )}

      {/* And the handoff email, which is owed on either route.
          Who booked the carrier and who is holding the box are two different
          questions. EZ Trans hold the machine whichever portal issued the
          label, and they do not touch a box they have not been emailed about —
          so a Freightcom booking on EZ Trans stock still has to queue the same
          confirmation, into the same end-of-day batch. It renders here with
          the label it was given rather than asking for one again. */}
      {isEzTrans && route === 'freightcom' && (
        <EzTransPanel
          row={row}
          order={order}
          onBatchChanged={onBatchChanged}
          starterGap={starterGap}
          externalLabel={{
            carrier,
            tracking_num: tracking,
            labelOnFile: freightcomConfirmed,
          }}
        />
      )}

      {/* The Goorooship panel renders nothing while it is still working out
          where the machines are, and nothing at all if that lookup fails. That
          used to be the reason for the duplicate card. The route picker is the
          better answer: an operator facing an empty step can switch to
          Freightcom and still record the booking. */}
      {route === 'goorooship' && !bookedLoading && (
        <p className={styles.bookingHint} data-testid="goorooship-escape">
          No Goorooship panel above? The machines on this order could not be
          located at EZ Trans. Switch to Freightcom to record the booking.
        </p>
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
