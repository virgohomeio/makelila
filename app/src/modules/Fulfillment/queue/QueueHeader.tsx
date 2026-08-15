import { useState } from 'react';
import {
  setQueuePriority, goBackStep, cancelOrderFromQueue, returnQueueRowToOrders,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import { orderDue } from '../../../lib/orders';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

const ADMIN_EMAILS = ['huayi@virgohome.io'] as const;

/** Which of the two "this order leaves the queue" panels is open, if any. */
type ExitPanel = 'cancel' | 'moveBack' | null;

export function QueueHeader({
  row,
  order,
  onRemoved,
}: {
  row: FulfillmentQueueRow;
  order: { order_ref: string; customer_name: string; city: string; region_state: string | null; country: 'US'|'CA'; placed_at: string | null; created_at: string; kind?: 'sale' | 'replacement' };
  /** Called once the row is gone from the queue, with a line to show in the
   *  now-empty detail pane (the row itself disappears via realtime). */
  onRemoved?: (message: string) => void;
}) {
  const due = orderDue(order.placed_at ?? order.created_at);
  const STEP_LABELS = ['', 'Assign', 'Test', 'Label', 'Dock', 'Email', 'Fulfilled'];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const fulfilled = row.step === 6;
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email as typeof ADMIN_EMAILS[number]);

  const handleTogglePriority = async () => {
    setBusy(true); setError(null);
    try { await setQueuePriority(row.id, !row.priority); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // The two ways an order leaves the queue without shipping. Both take a reason
  // (required to cancel, optional to move back) rather than a bare confirm —
  // "why did this order stop" is the thing anyone reading the log later wants.
  const [panel, setPanel] = useState<ExitPanel>(null);
  const [exitReason, setExitReason] = useState('');

  const openPanel = (next: ExitPanel) => {
    setPanel(prev => (prev === next ? null : next));
    setExitReason('');
    setError(null);
  };

  const handleCancelOrder = async () => {
    setBusy(true); setError(null);
    try {
      await cancelOrderFromQueue(row.id, exitReason);
      onRemoved?.(`${order.order_ref} — ${order.customer_name} was cancelled and removed from the queue.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const handleMoveBack = async () => {
    setBusy(true); setError(null);
    try {
      const landing = await returnQueueRowToOrders(row.id, exitReason);
      onRemoved?.(`${order.order_ref} — ${order.customer_name} left the queue and is back in ${landing.label}.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // Normal rewind available on steps 2-5. Step 6 (Fulfilled) can only be
  // rewound by admins (see ADMIN_EMAILS) — going back clears email_sent_at
  // and fulfilled_at so the order can be re-sent.
  const canGoBack =
    (row.step > 1 && row.step < 6) ||
    (row.step === 6 && isAdmin);
  const backTitle = row.step === 1
    ? 'No previous step — already at Assign'
    : row.step === 6 && !isAdmin
      ? 'Only Huayi can revert a fulfilled order'
      : `Back to ${STEP_LABELS[row.step - 1]}`;
  const handleBack = async () => {
    if (!canGoBack) return;
    const prevLabel = STEP_LABELS[row.step - 1];
    const confirmMsg = row.step === 6
      ? `Revert fulfillment? This clears the sent-email timestamp so the order drops back to "${prevLabel}" and can be re-sent.`
      : `Step back to "${prevLabel}"? Data already saved for later steps is kept.`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setError(null);
    try { await goBackStep(row.id, row.step); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const fulfilledOn = row.fulfilled_at
    ? new Date(row.fulfilled_at).toLocaleDateString('en-US')
    : '';

  return (
    <div className={styles.header}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.headerTitle}>
            {row.priority && !fulfilled && <span className={styles.priorityBadge} title="Priority — expedite">⭐</span>}
            {order.customer_name} — LILA Pro
            {/* A shipped replacement lives in the same SHIPPED list as a sale —
                the badge is what keeps the two tellable apart on the card. */}
            {order.kind === 'replacement' && (
              <span className="replBadge" title="Warranty / service replacement — not a sale">Replacement</span>
            )}
          </div>
          <div className={styles.headerMeta}>
            {order.order_ref} · {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
            {row.due_date && <> · Due {new Date(row.due_date).toLocaleDateString('en-US')}</>}
          </div>
        </div>
        <div className={styles.headerRight}>
          {fulfilled ? (
            <span
              className={`${styles.duePill} ${styles.fulfilledPill}`}
              title="Order fulfilled — shipment confirmation email sent to customer"
            >
              Fulfilled: {fulfilledOn || '—'}
            </span>
          ) : due.dueDate && (
            <span
              className={`${styles.duePill} ${styles[`due_${due.severity}`]}`}
              title="Order-confirmation SLA: placed date + 2 days"
            >
              Due: {due.dueLabel}
            </span>
          )}
          {!fulfilled && (
            <>
              <button
                className={panel === 'cancel' ? styles.exitBtnDangerOn : styles.exitBtnDanger}
                onClick={() => openPanel('cancel')}
                disabled={busy}
                aria-expanded={panel === 'cancel'}
                title="Cancel the whole order — it leaves the queue and every Order Review tab"
              >Cancel Order</button>
              <button
                className={panel === 'moveBack' ? styles.exitBtnOn : styles.exitBtn}
                onClick={() => openPanel('moveBack')}
                disabled={busy}
                aria-expanded={panel === 'moveBack'}
                title="Take this shipment out of the queue and put the order back in Sales › Orders"
              >Shipment Not Ready — Move Back to Orders</button>
            </>
          )}
          <button
            className={styles.backBtn}
            onClick={handleBack}
            disabled={busy || !canGoBack}
            title={backTitle}
          >← Back</button>
          {!fulfilled && (
            <button
              className={row.priority ? styles.priorityBtnOn : styles.priorityBtnOff}
              onClick={handleTogglePriority}
              disabled={busy}
              title="Sales: flag this order as priority so packers see it first"
            >
              {busy ? '…' : row.priority ? '⭐ Priority · clear' : '☆ Prioritize'}
            </button>
          )}
        </div>
      </div>
      {panel && (
        <div className={panel === 'cancel' ? styles.exitPanelDanger : styles.exitPanel}>
          <div className={styles.exitPanelTitle}>
            {panel === 'cancel'
              ? `Cancel ${order.order_ref} — ${order.customer_name}?`
              : `Move ${order.order_ref} back to Sales › Orders?`}
          </div>
          <ul className={styles.exitPanelList}>
            {panel === 'cancel' ? (
              <>
                <li>The order is removed from the fulfillment queue.</li>
                <li>It is marked cancelled and drops out of every Order Review tab.</li>
                {row.assigned_serial && <li>Unit {row.assigned_serial} goes back into ready stock.</li>}
                <li>A cancellation record opens in Shipping › Cancellations for the refund team.</li>
              </>
            ) : (
              <>
                <li>The shipment is removed from the fulfillment queue.</li>
                <li>The order goes back to Sales › Orders — Pending for a sale, or the Replacement tab (Ready / Awaiting Stock&nbsp;·&nbsp;Batch, by what&rsquo;s in stock) for a replacement.</li>
                {row.assigned_serial && <li>Unit {row.assigned_serial} goes back into ready stock.</li>}
                <li>Approving it again puts it back in the queue at step 1.</li>
              </>
            )}
          </ul>
          <textarea
            className={styles.exitPanelInput}
            value={exitReason}
            onChange={e => setExitReason(e.target.value)}
            rows={2}
            placeholder={panel === 'cancel'
              ? 'Reason for cancelling (required) — e.g. customer changed their mind'
              : 'Note (optional) — e.g. waiting on a replacement chamber'}
          />
          <div className={styles.exitPanelActions}>
            <button
              className={panel === 'cancel' ? styles.exitConfirmDanger : styles.exitConfirm}
              onClick={() => void (panel === 'cancel' ? handleCancelOrder() : handleMoveBack())}
              disabled={busy || (panel === 'cancel' && !exitReason.trim())}
            >
              {busy
                ? 'Working…'
                : panel === 'cancel' ? 'Cancel this order' : 'Move back to Orders'}
            </button>
            <button className={styles.backBtn} onClick={() => setPanel(null)} disabled={busy}>
              Never mind
            </button>
          </div>
        </div>
      )}
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 4 }}>{error}</div>}
      <div className={styles.progressBar} aria-label={`Step ${row.step} of 6 — ${STEP_LABELS[row.step]}`}>
        {[1,2,3,4,5,6].map(s => {
          // At step 6 every segment is "done" (green). Otherwise: past steps
          // are done, current step is highlighted, future steps are neutral.
          const isDone = fulfilled ? true : s < row.step;
          const isCurrent = !fulfilled && s === row.step;
          return (
            <div
              key={s}
              className={[
                styles.progressStep,
                isDone ? styles.done : '',
                isCurrent ? styles.current : '',
              ].filter(Boolean).join(' ')}
            />
          );
        })}
      </div>
    </div>
  );
}
