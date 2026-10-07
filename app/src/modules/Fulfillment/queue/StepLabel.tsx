import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { QUEUE_CARRIERS } from '../../../lib/queueCarrier';
import { starterBlocker } from '../../../lib/starterKit';
import { EzTransPanel, type EzTransOrder } from './EzTransPanel';
import { StepStarterKit, type StarterSkip } from './StepStarterKit';
import { StepBlockers } from './StepBlockers';
import styles from '../Fulfillment.module.css';


const FREIGHTCOM_URL = 'https://live.freightcom.com/c/mNyRdnwfdBn2raBkyImG9lemXej03RJB/ship/new';

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
  /** Is a machine on this order held at the EZ Trans 3PL? If so, EZ Trans has
   *  to be emailed before anybody can call a pickup scheduled — see the gate
   *  below. Defaults to false so a caller that cannot answer (or an order with
   *  no machine on it at all) gets the Freightcom behaviour, which is the one
   *  that asks for nothing extra. */
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
  // Seeded from the row so a label already attached — by the EZ Trans panel
  // below, or on an earlier pass that was rewound — doesn't have to be typed
  // in twice.
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
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Three gates on a Freightcom shipment, four on an EZ Trans one.
  //
  // The carrier and the Freightcom tracking number are the shipment itself.
  // The compost starter is the third: every machine sale ships a bag of soil
  // bought on Amazon, and asking for its tracking number only as an optional
  // US-only extra meant it got ordered when somebody remembered — three of 63
  // US rows had a number on 2026-10-07, and no CA row could have had one at
  // all. It is demanded here because here is the last moment it can be: the
  // carton goes to the 3PL next.
  //
  // This gate stranded orders once before, when it keyed on country alone and
  // an order with no starter kit had no number to paste (5a01566). It cannot
  // again: a replacement is exempt in code, and any other order can be let
  // through by an operator saying in writing why there is no soil on it. The
  // step is never shut against work that is actually finished.
  //
  // On an EZ Trans order the email is a third gate. This button is what books
  // the pickup — it moves the row to the dock handoff and into "To be picked
  // up", which says to everyone reading the queue that the carton is with the
  // 3PL and the carrier is coming for it. EZ Trans does not touch a box they
  // have not been emailed about, so clicking it before the booking email goes
  // out puts a carton in that rail that nobody is coming to collect. Confirm
  // the order into the day batch (or send the booking on its own) in the panel
  // above first.
  const blockers: string[] = [];
  if (!carrier) blockers.push('a carrier');
  if (!tracking.trim()) blockers.push('the Freightcom tracking number');
  const starterGap = starterBlocker(order, {
    starter_tracking_num: starterTracking,
    starter_skipped_at: starterSkip?.at ?? null,
  });
  if (starterGap) blockers.push(starterGap);
  const awaitingGoorooship = isEzTrans && !goorooshipSentAt;
  if (awaitingGoorooship) blockers.push('the Goorooship email to EZ Trans to go out');
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
          Goorooship email as much as Pickup scheduled — so a card the operator
          has to scroll past the disabled buttons to find would read as the app
          being broken rather than as work still to do. Renders nothing on a
          replacement. */}
      <StepStarterKit
        queueId={row.id}
        order={order}
        tracking={starterTracking}
        onTrackingChange={setStarterTracking}
        skip={starterSkip}
        onSkipChange={setStarterSkip}
      />

      {/* Renders only when the assigned unit is held at the EZTrans 3PL. */}
      <EzTransPanel
        row={row}
        order={order}
        onLabelSaved={({ carrier: c, tracking_num: t }) => { setCarrier(c); setTracking(t); }}
        onBatchChanged={onBatchChanged}
        starterGap={starterGap}
      />

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
          href={FREIGHTCOM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.extLinkBtn}
        >Freightcom — New Shipment ↗</a>
        <span style={{ marginLeft: 'auto', color: 'var(--color-info)' }}>
          LILA ships via Freightcom · compost starter ships via Amazon
        </span>
      </div>

      {/* LILA shipment section */}
      <div className={styles.labelSection}>
        <div className={styles.labelSectionHead}>LILA shipment (Freightcom)</div>

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
