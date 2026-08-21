import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { CRITERIA_COUNT } from './ReadinessChecklist';
import styles from '../OrderReview.module.css';

type ExpandedAction = 'flag' | 'hold' | 'info' | 'cancel' | null;

/** Copy for each reason drawer. The submit verb repeats the action's own name
 *  so a flow keeps one vocabulary end to end — the drawer opened from "Flag"
 *  is submitted with "Flag order", not a generic "Submit". */
const DRAWER: Record<Exclude<ExpandedAction, null>, {
  label: string;
  placeholder: string;
  submit: string;
  required: boolean;
}> = {
  flag:   { label: 'Why are you flagging this order?',    placeholder: 'Required — why this order is being flagged',    submit: 'Flag order',        required: true  },
  hold:   { label: 'Why are you holding this order?',     placeholder: 'Optional — why this order is being held',       submit: 'Hold order',        required: false },
  info:   { label: 'What do you need from the customer?', placeholder: 'Optional — what you need from the customer',    submit: 'Log request',       required: false },
  // "Cancel this order", not "Cancel order": the trigger button already
  // carries that exact label, and two identical labels on screen at once —
  // one that opens a drawer, one that destroys the order — is a trap.
  cancel: { label: 'Why are you cancelling this order?',  placeholder: 'Required — why this order is being cancelled',  submit: 'Cancel this order', required: true  },
};

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

  const discard = () => { setExpanded(null); setReason(''); };

  const open = (which: Exclude<ExpandedAction, null>) => {
    setReason('');
    setExpanded(prev => (prev === which ? null : which));
  };

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

  const drawer = expanded ? DRAWER[expanded] : null;
  const submitDisabled = !!drawer?.required && !reason.trim();

  return (
    <>
      {/* The bar never goes away. Opening a reason used to replace it
          entirely, taking the order's identity and the primary action with
          it. */}
      <div className={styles.actionBar}>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionConfirm}`}
          onClick={onApprove}
          disabled={!confirmReady}
          title={confirmReady
            ? 'Confirm this order'
            : `Clear the blockers below first — ${CRITERIA_COUNT} criteria must be met`}
        >✓ Confirm order</button>

        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionFlag}`}
          onClick={() => open('flag')}
          aria-expanded={expanded === 'flag'}
        >⚑ Flag</button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionHold}`}
          onClick={() => open('hold')}
          aria-expanded={expanded === 'hold'}
        >⏸ Hold</button>
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionInfo}`}
          onClick={() => open('info')}
          aria-expanded={expanded === 'info'}
        >? Need info</button>

        {/* Terminal, and there is no undo. It sits behind a divider at the far
            end rather than as a filled red slab beside the primary action. */}
        <span className={styles.actionRight}>
          <span className={styles.actionDivider} aria-hidden="true" />
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionCancel}`}
            onClick={() => open('cancel')}
            aria-expanded={expanded === 'cancel'}
            title="Cancel this order — it leaves every live tab and opens a cancellation record"
          >Cancel order</button>
        </span>
      </div>

      {drawer && (
        <div className={styles.reasonStack}>
          {expanded === 'cancel' && (
            <div className={styles.cancelWarning}>
              Cancelling {order.order_ref} is final — it leaves every live tab and opens a
              record in Shipping › Cancellations for the refund team. No refund is issued here.
            </div>
          )}
          <div className={styles.drawerLabel}>{drawer.label}</div>
          <div className={styles.reasonRow}>
            <input
              className={styles.reasonInput}
              autoFocus
              value={reason}
              placeholder={drawer.placeholder}
              onChange={e => setReason(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !submitDisabled) submit();
                if (e.key === 'Escape') discard();
              }}
            />
            {/* "Discard", not "Cancel": in this bar Cancel already means
                "kill the order". */}
            <button type="button" className={styles.reasonCancel} onClick={discard}>Discard</button>
            <button
              type="button"
              className={styles.reasonSubmit}
              disabled={submitDisabled}
              onClick={submit}
            >{drawer.submit}</button>
          </div>
        </div>
      )}
    </>
  );
}
