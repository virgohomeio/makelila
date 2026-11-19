import { useState } from 'react';
import styles from './PostShipment.module.css';

/** Pull a request off the Refunds board — with the reason it was pulled.
 *
 *  Shared by both card types, because "this card should not be here" is the
 *  same act whether it is a customer's cancellation form that queued itself as
 *  refund work or a refund card somebody opened by mistake. It is NOT a denial:
 *  a denial is a decision about the customer's money.
 *
 *  The reason is mandatory. A card that disappears with no explanation is
 *  indistinguishable from one that was processed, and the operator who finds
 *  the gap three weeks later has nothing to read. It is typed in place, in the
 *  same inline-confirm shape the Deny action uses, rather than in a
 *  window.prompt — a prompt cannot be reviewed, cannot hold a second sentence
 *  comfortably, and throws the text away the moment it is dismissed.
 */
export function CancelRequestAction({
  label = '✕ Cancel request',
  title = 'This request should not be on the board (test, duplicate, raised in error) — closes it with a reason',
  confirmLabel = 'Confirm cancel',
  disabled = false,
  onCancel,
  onError,
}: {
  label?: string;
  title?: string;
  confirmLabel?: string;
  disabled?: boolean;
  onCancel: (reason: string) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const note = reason.trim();
    if (!note) return;
    setBusy(true); onError(null);
    try {
      await onCancel(note);
      setOpen(false);
      setReason('');
    } catch (e) {
      // Leave the form open holding what they wrote: the write that fails here
      // is usually an RLS refusal, and retyping a paragraph to retry is a
      // punishment for the database's behaviour.
      onError((e as Error).message);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button
        className={styles.refundCloseBtn}
        disabled={disabled}
        title={title}
        onClick={() => { setOpen(true); onError(null); }}
      >{label}</button>
    );
  }

  return (
    <div className={styles.refundConfirmInline}>
      <textarea
        autoFocus
        rows={2}
        className={styles.refundConfirmInput}
        placeholder="Why is this request being cancelled? (required)"
        value={reason}
        disabled={busy}
        onChange={e => setReason(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); } }}
      />
      <div className={styles.refundConfirmBtns}>
        <button
          className={styles.refundDetailDenyBtn}
          disabled={busy || !reason.trim()}
          onClick={() => void run()}
        >{busy ? '…' : confirmLabel}</button>
        <button
          className={styles.refundCloseBtn}
          disabled={busy}
          onClick={() => setOpen(false)}
        >Keep request</button>
      </div>
    </div>
  );
}
