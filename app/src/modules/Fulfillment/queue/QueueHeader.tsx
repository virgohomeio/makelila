import { useState } from 'react';
import {
  setQueuePriority, goBackStep, cancelOrderFromQueue, returnQueueRowToOrders,
  flagOrderFromQueue, type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import { canRebookShipment, rebookShipment } from '../../../lib/rebookShipment';
import { orderDue, type Order } from '../../../lib/orders';
import { replacementItemsLabel } from '../../../lib/replacementTags';
import styles from '../Fulfillment.module.css';

/** Which of the header's confirm panels is open, if any.
 *
 *  The first three take the order out of the queue; the fourth keeps it and
 *  sends it backwards. All of them ask before they act, and all of them take a
 *  note — required to cancel and to flag, where the note is the whole point. */
type ExitPanel = 'cancel' | 'flag' | 'moveBack' | 'rebook' | null;

export function QueueHeader({
  row,
  order,
  onRemoved,
  onStepChanged,
}: {
  row: FulfillmentQueueRow;
  order: {
    order_ref: string; customer_name: string; city: string; region_state: string | null;
    country: 'US'|'CA'; placed_at: string | null; created_at: string;
    kind?: 'sale' | 'replacement';
    line_items?: Order['line_items'];
    linked_ticket_id?: string | null;
  };
  /** Called once the row is gone from the queue, with a line to show in the
   *  now-empty detail pane (the row itself disappears via realtime). */
  onRemoved?: (message: string) => void;
  /** Called after a step rewind is written, so the board can re-read rather
   *  than trusting the realtime socket to still be up. */
  onStepChanged?: () => void;
}) {
  const { profile, user } = useAuth();
  const operatorName = profile?.display_name ?? user?.email ?? 'Unknown';
  const due = orderDue(order.placed_at ?? order.created_at);
  const STEP_LABELS = ['', 'Assign', 'Test', 'Label', 'Dock', 'Email', 'Fulfilled'];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fulfilled = row.step === 6;

  const handleTogglePriority = async () => {
    setBusy(true); setError(null);
    try { await setQueuePriority(row.id, !row.priority); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // The three ways an order leaves the queue without shipping. All take a
  // reason (required to cancel and to flag, optional to move back) rather than
  // a bare confirm — "why did this order stop" is the thing anyone reading the
  // log, or the Sales tab it lands in, actually wants.
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

  // Flagging is for an order Sales has to answer something about — a bad
  // address, line items that don't match what was paid. The note is required:
  // it is the only thing that tells the person opening Sales › Flagged what
  // they are being asked to fix.
  const handleFlagOrder = async () => {
    setBusy(true); setError(null);
    try {
      await flagOrderFromQueue(row.id, exitReason, operatorName);
      onRemoved?.(`${order.order_ref} — ${order.customer_name} was flagged and is now in Sales › Flagged.`);
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

  // The booking was made and then cancelled — the carrier never came, or the
  // pickup was called off — and the whole shipment has to be booked again. The
  // row goes back to step 3 with carrier, tracking, the label, the dock
  // checklist and both emails cleared, keeping the pick and the test report.
  const canRebook = canRebookShipment(row);
  const handleRebook = async () => {
    setBusy(true); setError(null);
    try {
      await rebookShipment(row.id, exitReason);
      setPanel(null);
      setExitReason('');
      // Don't wait on the realtime socket: the row has just moved from Shipped
      // (or To be picked up) to Ready to ship, and the operator is about to
      // type a new tracking number into the step this reveals.
      onStepChanged?.();
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // Any step but the first can be rewound, by anyone on the team. Step 6 was
  // gated to a single hardcoded email address, which left everyone else unable
  // to undo a mis-click on the one step where a mis-click actually reaches the
  // customer. The confirm below still spells out what reverting clears.
  const canGoBack = row.step > 1;
  const backTitle = row.step === 1
    ? 'No previous step — already at Assign'
    : `Back to ${STEP_LABELS[row.step - 1]}`;
  const handleBack = async () => {
    if (!canGoBack) return;
    const prevLabel = STEP_LABELS[row.step - 1];
    const confirmMsg = row.step === 6
      ? `Revert fulfillment? This clears the sent-email timestamp so the order drops back to "${prevLabel}" and can be re-sent.`
      : `Step back to "${prevLabel}"? Data already saved for later steps is kept.`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setError(null);
    try {
      await goBackStep(row.id, row.step);
      // Don't wait on the realtime socket to show the move. If it has dropped,
      // the header would keep rendering the old step and the next click would
      // re-send the same rewind — which is exactly how #1252 got four identical
      // 5→4 entries in the log while the operator saw nothing happen.
      onStepChanged?.();
    }
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
            {/* A sale is always a machine, so "LILA Pro" was safe to hardcode
                until replacements started arriving here. A replacement can be a
                whole unit or a $24 lid — the card has to say which, or the
                person packing it is reading a label that is simply wrong. */}
            {order.customer_name} — {order.kind === 'replacement'
              ? replacementItemsLabel(order.line_items ?? [])
              : 'LILA Pro'}
            {/* A shipped replacement lives in the same SHIPPED list as a sale —
                the badge is what keeps the two tellable apart on the card. */}
            {order.kind === 'replacement' && (
              <span className="replBadge" title="Warranty / service replacement — not a sale">Replacement</span>
            )}
          </div>
          <div className={styles.headerMeta}>
            {order.order_ref} · {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
            {row.due_date && <> · Due {new Date(row.due_date).toLocaleDateString('en-US')}</>}
            {/* Why this box exists. Cancelling from here moves the ticket to
                On Hold, so the operator should be one click from reading it. */}
            {order.kind === 'replacement' && order.linked_ticket_id && (
              <> · <a href="#/service">originating ticket</a></>
            )}
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
          {canRebook && (
            <button
              className={panel === 'rebook' ? styles.exitBtnOn : styles.exitBtn}
              onClick={() => openPanel('rebook')}
              disabled={busy}
              aria-expanded={panel === 'rebook'}
              title="The carrier booking was cancelled — send this order back to the label step to book a new shipment"
            >Rebook Shipment</button>
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
              {/* Not offered on a replacement: Sales lists no replacements, so
                  flagging one would take it out of the queue and put it on a
                  screen where it does not appear. flagOrderFromQueue refuses
                  one too — this just keeps the dead button off the card. */}
              {order.kind !== 'replacement' && (
                <button
                  className={panel === 'flag' ? styles.exitBtnWarnOn : styles.exitBtnWarn}
                  onClick={() => openPanel('flag')}
                  disabled={busy}
                  aria-expanded={panel === 'flag'}
                  title="Flag this order for Sales — it leaves the queue with your note and lands in Sales › Flagged"
                >Flag Order</button>
              )}
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
        <div className={
          panel === 'cancel' ? styles.exitPanelDanger
          : panel === 'flag' ? styles.exitPanelWarn
          : styles.exitPanel
        }>
          <div className={styles.exitPanelTitle}>
            {panel === 'cancel'
              ? `Cancel ${order.order_ref} — ${order.customer_name}?`
              : panel === 'flag'
                ? `Flag ${order.order_ref} — ${order.customer_name} for Sales?`
                : panel === 'rebook'
                  ? `Book a new shipment for ${order.order_ref} — ${order.customer_name}?`
                  : `Move ${order.order_ref} back to Sales › Orders?`}
          </div>
          <ul className={styles.exitPanelList}>
            {panel === 'rebook' ? (
              <>
                <li>
                  The order goes back to <strong>Ready to ship</strong> at step 3 (Label), where a
                  new carrier, tracking number and label are attached.
                </li>
                <li>
                  The cancelled booking is cleared
                  {(row.carrier || row.tracking_num)
                    ? <> — {[row.carrier, row.tracking_num].filter(Boolean).join(' · ')} comes off the
                        row, along with the label PDF and the dock checklist.</>
                    : <> — the label PDF and the dock checklist come off the row.</>}
                </li>
                <li>
                  Goorooship is told again: the order drops out of the batch it was sent in and can be
                  confirmed into a new day&rsquo;s batch.
                </li>
                <li>
                  The customer&rsquo;s shipment email can be sent again, with the new tracking number.
                </li>
                {row.assigned_serials.length > 0 && (
                  <li>
                    Unit{row.assigned_serials.length === 1 ? '' : 's'}{' '}
                    {row.assigned_serials.join(', ')} stay{row.assigned_serials.length === 1 ? 's' : ''}{' '}
                    with this order, reserved — the pick and the test report are kept. A machine the
                    queue had marked shipped goes back on the shelf.
                  </li>
                )}
              </>
            ) : panel === 'flag' ? (
              <>
                <li>The order is removed from the fulfillment queue.</li>
                <li>
                  It is marked <strong>flagged</strong> and moves to{' '}
                  <strong>Sales › Flagged</strong>, where your note is on the order.
                </li>
                {row.assigned_serials.length > 0 && (
                  <li>
                    Unit{row.assigned_serials.length === 1 ? '' : 's'}{' '}
                    {row.assigned_serials.join(', ')} go{row.assigned_serials.length === 1 ? 'es' : ''} back into ready stock.
                  </li>
                )}
                <li>Nothing is cancelled and no refund is raised — confirming the order again puts it back in the queue at step 1.</li>
              </>
            ) : panel === 'cancel' ? (
              <>
                <li>The order is removed from the fulfillment queue.</li>
                <li>It is marked cancelled and drops out of every Order Review tab.</li>
                {row.assigned_serials.length > 0 && (
                  <li>
                    Unit{row.assigned_serials.length === 1 ? '' : 's'}{' '}
                    {row.assigned_serials.join(', ')} go{row.assigned_serials.length === 1 ? 'es' : ''} back into ready stock.
                  </li>
                )}
                <li>A cancellation record opens in Shipping › Cancellations for the refund team.</li>
              </>
            ) : (
              <>
                <li>The shipment is removed from the fulfillment queue.</li>
                <li>The order goes back to Sales › Orders — Pending for a sale, or the Replacement tab (Ready / Awaiting Stock&nbsp;·&nbsp;Batch, by what&rsquo;s in stock) for a replacement.</li>
                {row.assigned_serials.length > 0 && (
                  <li>
                    Unit{row.assigned_serials.length === 1 ? '' : 's'}{' '}
                    {row.assigned_serials.join(', ')} go{row.assigned_serials.length === 1 ? 'es' : ''} back into ready stock.
                  </li>
                )}
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
              : panel === 'flag'
                ? 'Why are you flagging this order? (required) — e.g. address is a PO box, customer has not confirmed the colour'
                : panel === 'rebook'
                  ? 'Note (optional) — e.g. pickup cancelled, rebooking with GLS'
                  : 'Note (optional) — e.g. waiting on a replacement chamber'}
          />
          <div className={styles.exitPanelActions}>
            <button
              className={
                panel === 'cancel' ? styles.exitConfirmDanger
                : panel === 'flag' ? styles.exitConfirmWarn
                : styles.exitConfirm
              }
              onClick={() => void (
                panel === 'cancel' ? handleCancelOrder()
                : panel === 'flag' ? handleFlagOrder()
                : panel === 'rebook' ? handleRebook()
                : handleMoveBack()
              )}
              disabled={busy || ((panel === 'cancel' || panel === 'flag') && !exitReason.trim())}
            >
              {busy
                ? 'Working…'
                : panel === 'cancel' ? 'Cancel this order'
                : panel === 'flag' ? 'Flag this order'
                : panel === 'rebook' ? 'Rebook this shipment'
                : 'Move back to Orders'}
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
