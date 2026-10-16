import { useState } from 'react';
import {
  amazonOrdersUrl,
  saveStarterTracking,
  skipStarterKit,
  starterRequired,
  starterSkipErrorMessage,
  unskipStarterKit,
  type StarterKitOrder,
} from '../../../lib/starterKit';
import styles from '../Fulfillment.module.css';

export type StarterKitOrderRef = StarterKitOrder & {
  id: string;
  order_ref: string;
  customer_name?: string | null;
};

/** An operator's answer to "what about the starter soil?" — a tracking number,
 *  or a declared exemption with a reason on it. */
export type StarterSkip = { at: string; reason: string };

/** The compost starter, as a step-3 prerequisite.
 *
 *  Every machine sale ships a bag of starter soil that does not come out of our
 *  warehouse — it is bought on Amazon and goes to the customer direct. Until
 *  now the app had only a quiet optional field for its tracking number, on US
 *  orders alone, and it was filled in three times in 63 rows. This card is the
 *  same number asked for out loud, as something step 3 is waiting on: the
 *  Goorooship email will not go out and the pickup cannot be scheduled until it
 *  is answered.
 *
 *  Fully controlled. StepLabel owns both answers because its gate is the point
 *  of them — a card holding its own copy would let the two disagree, which is
 *  the one failure that matters here: a step that will not open after the
 *  operator has already done the work. */
export function StepStarterKit({
  queueId,
  order,
  tracking,
  onTrackingChange,
  skip,
  onSkipChange,
}: {
  queueId: string;
  order: StarterKitOrderRef;
  tracking: string;
  onTrackingChange: (v: string) => void;
  skip: StarterSkip | null;
  onSkipChange: (v: StarterSkip | null) => void;
}) {
  const [reason, setReason] = useState<string>(skip?.reason ?? '');
  const [declaring, setDeclaring] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = { orderRef: order.order_ref, orderId: order.id };

  // A replacement is exempt by its kind: it goes to somebody who already bought
  // a machine and already has the soil that came with it. Nothing to render.
  if (!starterRequired(order)) return null;

  const store = order.country === 'CA' ? 'Amazon.ca' : 'Amazon.com';
  const hasNumber = !!tracking.trim();

  /** Keep the number on the row as soon as it is typed, not at the end of the
   *  step. The Goorooship email is gated on it and goes out first — an operator
   *  who typed it, mailed the 3PL, then reloaded would otherwise come back to
   *  an empty field and a step that would not let them past. */
  const persist = async () => {
    setSaveError(null);
    try {
      await saveStarterTracking(queueId, tracking);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  const handleDeclare = async () => {
    setBusy(true); setError(null);
    try {
      await skipStarterKit(queueId, reason, refs);
      onSkipChange({ at: new Date().toISOString(), reason: reason.trim() });
      onTrackingChange('');
      setDeclaring(false);
    } catch (e) {
      setError(starterSkipErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async () => {
    setBusy(true); setError(null);
    try {
      await unskipStarterKit(queueId, refs);
      onSkipChange(null);
    } catch (e) {
      setError(starterSkipErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.starterCard} data-testid="starter-kit-card">
      <div className={styles.starterHead}>
        <span className={styles.labelSectionHead}>Compost starter kit (Amazon)</span>
        {skip ? (
          <span className={styles.starterExemptTag}>No starter on this order</span>
        ) : hasNumber ? (
          <span className={styles.starterDoneTag}>✓ Ordered</span>
        ) : (
          <span className={styles.starterRequiredTag}>Required</span>
        )}
      </div>

      {skip ? (
        <>
          <p className={styles.starterLead}>
            Declared as shipping no starter soil
            {Number.isNaN(Date.parse(skip.at)) ? '' : ` on ${new Date(skip.at).toLocaleString()}`}
            {skip.reason ? ` — ${skip.reason}` : ''}
          </p>
          <div className={styles.bookingStepRow}>
            <button
              type="button"
              className={styles.bookingPreviewToggle}
              onClick={handleWithdraw}
              disabled={busy}
            >{busy ? 'Saving…' : 'It does ship a starter — undo this'}</button>
            <span className={styles.bookingHint}>
              Recorded in the activity log against {order.order_ref}.
            </span>
          </div>
        </>
      ) : (
        <>
          <p className={styles.starterLead}>
            Order the customer's starter soil, then paste the {store} tracking
            number. Both the Goorooship email and <strong>Pickup scheduled</strong> wait
            on it — once the carton is with the 3PL there is no adding a bag of
            soil to it.
          </p>

          <div className={styles.bookingStepRow}>
            <a
              href={amazonOrdersUrl(order.country)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >{store} — Order starter soil ↗</a>
            <span className={styles.bookingHint}>
              Ships direct to {order.customer_name || 'the customer'} — it is not
              in our warehouse and never joins this carton.
            </span>
          </div>

          <div className={styles.bookingForm}>
            <label>
              {store} tracking number:
              <input
                type="text"
                value={tracking}
                onChange={e => onTrackingChange(e.target.value)}
                onBlur={() => { void persist(); }}
                placeholder="Paste from the Amazon order details"
                data-testid="starter-tracking-input"
              />
            </label>
          </div>

          {declaring ? (
            <div className={styles.starterSkipForm}>
              <label>
                Why does this order ship no starter soil?
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. customer already has one from order #1142"
                  data-testid="starter-skip-reason"
                />
              </label>
              <div className={styles.bookingStepRow}>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={handleDeclare}
                  disabled={busy || !reason.trim()}
                >{busy ? 'Saving…' : 'Record this and carry on'}</button>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => setDeclaring(false)}
                  disabled={busy}
                >Cancel</button>
                <span className={styles.bookingHint}>
                  {reason.trim()
                    ? 'Goes on the row and into the activity log.'
                    : 'A reason is required — without one this reads exactly like a starter nobody ordered.'}
                </span>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={styles.starterSkipLink}
              onClick={() => setDeclaring(true)}
            >This order ships no starter soil</button>
          )}
        </>
      )}

      {saveError && <p className={styles.error}>Could not save the number: {saveError}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
