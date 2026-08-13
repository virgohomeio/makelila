import { useState } from 'react';
import { orderDue, type Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

type ExpandedAction = 'flag' | 'hold' | 'info' | 'cancel' | null;

export function ActionBar({
  order,
  onApprove,
  onFlag,
  onHold,
  onNeedInfo,
  onCancelOrder,
  confirmReady = true,
}: {
  order: Order;
  onApprove: () => void;
  onFlag: (reason: string) => void;
  onHold: (reason: string) => void;
  onNeedInfo: (note: string) => void;
  onCancelOrder: (reason: string) => void;
  confirmReady?: boolean;
}) {
  const due = orderDue(order.placed_at ?? order.created_at);
  const [expanded, setExpanded] = useState<ExpandedAction>(null);
  const [reason, setReason] = useState('');

  const submit = () => {
    if (expanded === 'flag') {
      if (!reason.trim()) return;
      onFlag(reason);
    } else if (expanded === 'hold') {
      onHold(reason);
    } else if (expanded === 'info') {
      onNeedInfo(reason);
    } else if (expanded === 'cancel') {
      if (!reason.trim()) return;
      onCancelOrder(reason);
    }
    setExpanded(null);
    setReason('');
  };

  const cancel = () => { setExpanded(null); setReason(''); };

  // Cancelling is terminal and there is no un-cancel anywhere in the app, so a
  // cancelled order gets a read-only summary instead of actions that would
  // quietly resurrect it.
  if (order.status === 'cancelled') {
    const on = order.cancelled_at
      ? new Date(order.cancelled_at).toLocaleDateString('en-US')
      : null;
    return (
      <div className={styles.actionBar}>
        <span className={styles.cancelledBar}>
          ✕ Cancelled{on ? ` ${on}` : ''}
          {order.cancelled_reason ? ` — ${order.cancelled_reason}` : ''}
        </span>
      </div>
    );
  }

  if (expanded) {
    const placeholder =
      expanded === 'flag'   ? 'Why is this being flagged? (required)' :
      expanded === 'hold'   ? 'Why is this being held? (optional)' :
      expanded === 'cancel' ? 'Why is this order being cancelled? (required)' :
                              'What info is needed from the customer? (optional)';
    const submitDisabled = (expanded === 'flag' || expanded === 'cancel') && !reason.trim();
    return (
      <div className={styles.actionBar}>
        <div className={styles.reasonStack}>
          {expanded === 'cancel' && (
            <div className={styles.cancelWarning}>
              Cancelling {order.order_ref} is final — it leaves every live tab and opens a
              record in Shipping › Cancellations for the refund team. No refund is issued here.
            </div>
          )}
          <div className={styles.reasonRow}>
            <input
              className={styles.reasonInput}
              autoFocus
              value={reason}
              placeholder={placeholder}
              onChange={e => setReason(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !submitDisabled) submit();
                if (e.key === 'Escape') cancel();
              }}
            />
            <button
              className={styles.reasonSubmit}
              disabled={submitDisabled}
              onClick={submit}
            >Submit</button>
            <button className={styles.reasonCancel} onClick={cancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.actionBar}>
      <button
        className={`${styles.actionBtn} ${styles.actionConfirm}`}
        onClick={onApprove}
        disabled={!confirmReady}
        style={!confirmReady ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        title={!confirmReady ? 'Complete the 3 readiness criteria first' : 'Confirm order'}
      >✓ Confirm</button>
      <button
        className={`${styles.actionBtn} ${styles.actionCancel}`}
        onClick={() => setExpanded('cancel')}
        title="Cancel this order — it leaves every live tab and opens a cancellation record"
      >✕ Cancel</button>
      <button className={`${styles.actionBtn} ${styles.actionFlag}`}    onClick={() => setExpanded('flag')}>⚑ Flag</button>
      <button className={`${styles.actionBtn} ${styles.actionHold}`}    onClick={() => setExpanded('hold')}>⏸ Hold</button>
      <button className={`${styles.actionBtn} ${styles.actionInfo}`}    onClick={() => setExpanded('info')}>? Need Info</button>
      {!confirmReady && (
        <span style={{ fontSize: 10, color: 'var(--color-ink-faint)', marginLeft: 4 }}>
          Complete 3 criteria to enable Confirm
        </span>
      )}
      {due.dueDate && (
        <span
          className={`${styles.duePill} ${styles[`due_${due.severity}`]}`}
          title="Order-confirmation SLA: placed date + 2 days"
        >
          Due: {due.dueLabel}
        </span>
      )}
    </div>
  );
}
