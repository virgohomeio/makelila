import { useState } from 'react';
import {
  amazonOrdersUrl,
  setStarterOrdered,
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

/** An operator's "this order ships no soil" answer, with the reason. */
export type StarterSkip = { at: string; reason: string };

/** Step 3's starter-soil check: one checkbox — "Starter soil ordered".
 *
 *  Every machine sale ships a bag of starter soil bought on Amazon and sent to
 *  the customer direct. Step 3 waits on it because once the pickup is booked
 *  there is no adding soil to the shipment. A replacement owes none and the
 *  card renders nothing. For the odd sale that needs no soil, a small link
 *  records why (kept so such an order is never stuck at step 3).
 *
 *  Fully controlled — StepLabel owns the answers because its gate reads them. */
export function StepStarterKit({
  queueId,
  order,
  ordered,
  onOrderedChange,
  skip,
  onSkipChange,
}: {
  queueId: string;
  order: StarterKitOrderRef;
  /** Ticked (or an old row that already carries an Amazon tracking number). */
  ordered: boolean;
  onOrderedChange: (v: boolean) => void;
  skip: StarterSkip | null;
  onSkipChange: (v: StarterSkip | null) => void;
}) {
  const [reason, setReason] = useState<string>(skip?.reason ?? '');
  const [declaring, setDeclaring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = { orderRef: order.order_ref, orderId: order.id };

  if (!starterRequired(order)) return null;

  const store = order.country === 'CA' ? 'Amazon.ca' : 'Amazon.com';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(starterSkipErrorMessage(e)); }
    finally { setBusy(false); }
  };

  const toggleOrdered = (next: boolean) => run(async () => {
    await setStarterOrdered(queueId, next, refs);
    onOrderedChange(next);
  });

  const declare = () => run(async () => {
    await skipStarterKit(queueId, reason, refs);
    onSkipChange({ at: new Date().toISOString(), reason: reason.trim() });
    setDeclaring(false);
  });

  const withdraw = () => run(async () => {
    await unskipStarterKit(queueId, refs);
    onSkipChange(null);
  });

  return (
    <div className={styles.starterCard} data-testid="starter-kit-card">
      {skip ? (
        <div className={styles.bookingStepRow}>
          <span className={styles.starterExemptTag}>No starter soil</span>
          <span className={styles.bookingHint}>{skip.reason}</span>
          <button
            type="button"
            className={styles.starterSkipLink}
            onClick={withdraw}
            disabled={busy}
          >Undo</button>
        </div>
      ) : (
        <>
          <div className={styles.bookingStepRow}>
            <label className={styles.starterCheck}>
              <input
                type="checkbox"
                checked={ordered}
                disabled={busy}
                onChange={e => { void toggleOrdered(e.target.checked); }}
                data-testid="starter-ordered-checkbox"
              />
              Starter soil ordered
            </label>
            <a
              href={amazonOrdersUrl(order.country)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >Order on {store} ↗</a>
            {!ordered && !declaring && (
              <button
                type="button"
                className={styles.starterSkipLink}
                onClick={() => setDeclaring(true)}
              >No soil needed?</button>
            )}
          </div>

          {declaring && (
            <div className={styles.starterSkipForm}>
              <label>
                Why no starter soil?
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. customer already has one"
                  data-testid="starter-skip-reason"
                />
              </label>
              <div className={styles.bookingStepRow}>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={declare}
                  disabled={busy || !reason.trim()}
                >{busy ? 'Saving…' : 'Save'}</button>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => setDeclaring(false)}
                  disabled={busy}
                >Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
