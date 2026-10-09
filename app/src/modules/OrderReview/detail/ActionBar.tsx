import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { criteriaCount } from './ReadinessChecklist';
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
  onUncancel,
  onReleaseHold,
  onClearReplacementFlag,
  clearFlagBlockedBy,
  onForceClearReplacementFlag,
  onDismissClearFlagBlock,
  confirmReady = true,
}: {
  order: Order;
  onApprove: () => void;
  onFlag: (reason: string) => void;
  onHold: (reason: string) => void;
  onNeedInfo: (note: string) => void;
  onCancelOrder: (reason: string) => void;
  /** Only the Cancelled view passes this — the way back out of a mis-click. */
  onUncancel?: () => void;
  /** Only a held order passes this — the way back out of a hold. */
  onReleaseHold?: () => void;
  /** Only a flagged REPLACEMENT passes this — the single action that pane
   *  offers. See the replacement branch below for why it is the only one. */
  onClearReplacementFlag?: () => void;
  /** The parts the last re-queue attempt came back short of, if it did. Turns
   *  the button into the override question. */
  clearFlagBlockedBy?: string | null;
  onForceClearReplacementFlag?: () => void;
  onDismissClearFlagBlock?: () => void;
  confirmReady?: boolean;
}) {
  const [expanded, setExpanded] = useState<ExpandedAction>(null);
  const [reason, setReason] = useState('');
  const [confirmingUncancel, setConfirmingUncancel] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);

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

  // A cancelled order gets a read-only summary instead of the review actions —
  // it is out of the queue and nothing about it is still being decided. The one
  // action it keeps is the way back: a cancel is a single click, and it used to
  // be unfixable outside the database. Reviving it is gated by uncancelOrder,
  // which refuses once money has moved, and by a confirm step here.
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
        {onUncancel && (confirmingUncancel ? (
          <span className={styles.uncancelConfirm}>
            <span className={styles.uncancelAsk}>
              Move {order.order_ref} back to Pending? It returns to review and has to be
              confirmed again.
            </span>
            <button
              type="button"
              className={styles.reasonCancel}
              onClick={() => setConfirmingUncancel(false)}
            >Discard</button>
            <button
              type="button"
              className={styles.reasonSubmit}
              onClick={() => { setConfirmingUncancel(false); onUncancel(); }}
            >Move back to Pending</button>
          </span>
        ) : (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionUncancel}`}
            onClick={() => setConfirmingUncancel(true)}
            title="Undo this cancellation — the order goes back to Pending for review"
          >↩ Move back to Pending</button>
        ))}
      </div>
    );
  }

  // A flagged replacement is the one non-sale that reaches this pane at all:
  // bucketOrders admits it so the flag has somewhere to be answered. Almost
  // none of the review actions below are safe on one.
  //
  //   - "Confirm order" writes status='approved', which fires
  //     auto_enqueue_approved_order and puts the order straight back in the ship
  //     queue WITHOUT resolving what stock it actually needs. That is the exact
  //     shape of the bug that killed the old Sales Replacement tab (0fb7f45):
  //     a sales control writing a status while the replacement pipeline read a
  //     different column.
  //   - "Hold" writes a status bucketOrders does not admit for a replacement,
  //     so the order would vanish out of Sales with no way back to it.
  //   - "Cancel order" does work correctly on a replacement, but the cancelled
  //     row is not bucketed either, so the pane would blank out mid-action.
  //
  // So it gets the one action that is correct: clear the flag through the
  // replacement's OWN re-queue path, which re-derives stock from scratch rather
  // than trusting a replacement_state stamped months ago. Everything else about
  // the order is worked in Fulfillment › Replacements, which lists it the whole
  // time it is flagged.
  //
  // When that re-check comes back short, the shortfall is a question and not a
  // wall: the same inline confirm the uncancel and release use, offering the
  // same override Fulfillment › Replacements offers. Without it a flagged
  // replacement the parts table can't account for had no way out of this pane.
  if (order.kind === 'replacement') {
    return (
      <div className={styles.actionBar}>
        <span className={styles.flaggedBar}>
          ⚑ Flagged replacement — cancelling, re-planning and shipping it all live in
          Fulfillment › Replacements
        </span>
        {onClearReplacementFlag && (clearFlagBlockedBy ? (
          <span className={styles.uncancelConfirm}>
            <span className={styles.uncancelAsk}>
              Stock looks short for {order.order_ref}: {clearFlagBlockedBy}. Queue it anyway?
              The override is recorded on the order.
            </span>
            <button
              type="button"
              className={styles.reasonCancel}
              onClick={onDismissClearFlagBlock}
            >Discard</button>
            <button
              type="button"
              className={styles.reasonSubmit}
              onClick={onForceClearReplacementFlag}
            >Queue it anyway</button>
          </span>
        ) : (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionRelease}`}
            onClick={onClearReplacementFlag}
            title="Clear the flag — re-checks the stock this replacement needs and puts it back in Fulfillment › Queue"
          >▶ Clear flag &amp; re-queue</button>
        ))}
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
            : `Clear the blockers below first — ${criteriaCount(order)} criteria must be met`}
        >✓ Confirm order</button>

        {/* Holding is one click; until this button existed, un-holding was not
            possible from the app at all. It sits beside Confirm because those
            are the only two ways out of the Held tab, and it carries the same
            inline confirm step as the uncancel above — a release moves the
            order AND pulls its fulfillment row, which is too much to do on a
            stray click. */}
        {order.status === 'held' && onReleaseHold && (confirmingRelease ? (
          <span className={styles.uncancelConfirm}>
            <span className={styles.uncancelAsk}>
              Release the hold on {order.order_ref}? It goes back to Pending for review, and
              any unshipped fulfillment row it still has is pulled.
            </span>
            <button
              type="button"
              className={styles.reasonCancel}
              onClick={() => setConfirmingRelease(false)}
            >Discard</button>
            <button
              type="button"
              className={styles.reasonSubmit}
              onClick={() => { setConfirmingRelease(false); onReleaseHold(); }}
            >Release hold</button>
          </span>
        ) : (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionRelease}`}
            onClick={() => setConfirmingRelease(true)}
            title="Release this hold — the order goes back to Pending for review"
          >▶ Release hold</button>
        ))}

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

        {/* Takes the order out of every live tab, and the only way back is the
            Cancelled view. It sits behind a divider at the far end rather than
            as a filled red slab beside the primary action. */}
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
              Cancelling {order.order_ref} takes it out of every live tab and opens a record
              in Shipping › Cancellations for the refund team. No refund is issued here. Until
              that record becomes a refund it can be moved back to Pending from Cancelled.
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
