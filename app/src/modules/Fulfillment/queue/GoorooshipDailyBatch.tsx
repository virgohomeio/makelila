import { useState } from 'react';
import {
  sendEzTransDailyBatch,
  useDailyBatch,
  previewOrdersBlock,
  EZTRANS_BATCH_SENT_ACTION,
  type EzTransBatchItem,
  type EzTransBatchOrder,
  type EzTransBatchQueueRow,
  type EzTransBatchSendResult,
} from '../../../lib/eztransBatch';
import { EZTRANS_CC, EZTRANS_EMAIL } from '../../../lib/eztrans';
import { logAction } from '../../../lib/activityLog';
import styles from '../Fulfillment.module.css';

/** The end-of-day Goorooship email, at the bottom of the Fulfillment queue.
 *
 *  EZ Trans asked for every shipment scheduled for a day to arrive in one
 *  message rather than one per box: a picker working a stack of ten cartons
 *  out of ten separate emails loses one. So step 3 confirms an order into the
 *  day's batch and this bar sends the lot — one PDF per order holding its
 *  shipping label and packing list, with the US pesticide worksheet beside
 *  it as its own file, every attachment named for the customer and the
 *  tracking number so the 3PL knows at a glance which carton it belongs to.
 *
 *  Fed the queue rows the page already holds rather than re-reading them, so
 *  what is listed here is the same data the step panels are working from. */
export function GoorooshipDailyBatch({
  rows,
  orders,
  onSent,
}: {
  rows: EzTransBatchQueueRow[];
  orders: Map<string, EzTransBatchOrder>;
  onSent?: () => void;
}) {
  const { pending, sent, day } = useDailyBatch(rows, orders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EzTransBatchSendResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const handleSend = async () => {
    if (pending.length === 0) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await sendEzTransDailyBatch(pending.map(i => i.queueId));
      setResult(res);
      // One log line per order, against the order, because that is where the
      // rest of an order's history lives and "was this box told to the 3PL?"
      // is asked one order at a time.
      for (const o of res.orders) {
        await logAction(
          EZTRANS_BATCH_SENT_ACTION,
          o.order_ref,
          `Sent to ${res.to} in the ${day} Goorooship batch of ${res.orders.length} ` +
          `shipment${res.orders.length === 1 ? '' : 's'} — tracking ${o.tracking}, ` +
          `documents ${o.documents.join(', ')}` +
          `${res.sent_via === 'gmail'
              ? ` · sent from ${res.from ?? 'the sender'} — in their Gmail Sent folder`
              : ' · sent via Resend — no copy in the sender’s Sent folder'}` +
          `${res.warning ? ` · ${res.warning}` : ''}`,
          {
            entityType: 'order',
            entityId: o.order_id,
            ...(o.serial ? { unitSerial: o.serial } : {}),
          },
        );
      }
      onSent?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.batchFooter} aria-label="Today's Goorooship batch">
      <div className={styles.batchFooterHead}>
        <span className={styles.batchTitle}>Today's Goorooship batch — {day}</span>
        <span className={styles.batchCount}>
          {pending.length} waiting
          {sent.length > 0 ? ` · ${sent.length} already sent today` : ''}
        </span>
        {pending.length > 0 && (
          <button
            type="button"
            className={styles.bookingPreviewToggle}
            onClick={() => setShowPreview(v => !v)}
          >{showPreview ? 'Hide the email' : 'Preview the email'}</button>
        )}
      </div>

      {pending.length === 0 && sent.length === 0 ? (
        <p className={styles.batchEmpty}>
          Nothing is confirmed for EZ Trans today. Confirm an order's carrier,
          tracking number and packing list in step 3 and it will queue up here.
        </p>
      ) : (
        <ul className={styles.batchList}>
          {[...pending, ...sent].map(item => (
            <BatchRow key={item.queueId} item={item} />
          ))}
        </ul>
      )}

      {showPreview && pending.length > 0 && (
        <pre className={styles.bookingPreview}>
          {`To: ${EZTRANS_EMAIL}\nCc: ${EZTRANS_CC.join(', ')}\n\n` + previewOrdersBlock(pending)}
        </pre>
      )}

      <div className={styles.batchActions}>
        <button
          className={styles.confirmBtn}
          onClick={handleSend}
          disabled={busy || pending.length === 0}
        >
          {busy
            ? 'Sending…'
            : `✉ Email Today's Fulfilled Orders to Goorooship${pending.length ? ` (${pending.length})` : ''}`}
        </button>
        <span className={styles.bookingHint}>
          One email to {EZTRANS_EMAIL} carrying every order confirmed today. Each order's
          shipping label and packing list go as one PDF; a US shipment's pesticide
          worksheet goes as a second file, both named for the customer and the tracking number.
          The email tells them the worksheet is a customs document to upload for the broker,
          not paperwork for the carton.
        </span>
      </div>

      {result && (
        <div className={styles.bookingSent}>
          ✓ {result.orders.length} shipment{result.orders.length === 1 ? '' : 's'} sent to {result.to}
          {result.cc.length ? ` (cc ${result.cc.join(', ')})` : ''}.
          <div>Attached: {result.attachments.join(', ')}</div>
          {result.from && (
            <div>
              {result.sent_via === 'gmail'
                ? `Sent from ${result.from} — it is in that mailbox's Sent folder.`
                : `Sent from ${result.from} via Resend — there is no copy in that mailbox's Sent folder.`}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div className={styles.bookingWarning}>
              ⚠ Not included: {result.skipped
                .map(s => `${s.order_ref ?? s.queue_id} (${s.reason})`)
                .join('; ')}
            </div>
          )}
        </div>
      )}
      {result?.warning && <div className={styles.bookingWarning}>⚠ {result.warning}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </section>
  );
}

function BatchRow({ item }: { item: EzTransBatchItem }) {
  return (
    <li className={item.sentAt ? `${styles.batchItem} ${styles.batchItemSent}` : styles.batchItem}>
      <div className={styles.batchItemMain}>
        <strong>{item.customerName}</strong>
        <span>{item.orderRef}</span>
        <span>{item.carrier} · {item.tracking}</span>
        {item.serial && <span>{item.serial}</span>}
        {item.worksheet && <span className={styles.batchTag}>pesticide worksheet</span>}
        {item.packingListEdited && <span className={styles.batchTag}>packing list edited</span>}
        {item.sentAt && (
          <span className={styles.batchTag}>sent {new Date(item.sentAt).toLocaleTimeString()}</span>
        )}
      </div>
      <div className={styles.batchDocs}>{item.documents.join(' · ')}</div>
    </li>
  );
}
