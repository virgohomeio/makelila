import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

type ExpandedAction = 'flag' | 'hold' | 'info' | null;

export function ActionBar({
  onApprove,
  onFlag,
  onHold,
  onNeedInfo,
  confirmReady = true,
}: {
  order: Order;
  onApprove: () => void;
  onFlag: (reason: string) => void;
  onHold: (reason: string) => void;
  onNeedInfo: (note: string) => void;
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
    }
    setExpanded(null);
    setReason('');
  };

  const cancel = () => { setExpanded(null); setReason(''); };

  if (expanded) {
    const placeholder =
      expanded === 'flag' ? 'Why is this being flagged? (required)' :
      expanded === 'hold' ? 'Why is this being held? (optional)' :
                            'What info is needed from the customer? (optional)';
    const submitDisabled = expanded === 'flag' && !reason.trim();
    return (
      <div className={styles.actionBar}>
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
      <button className={`${styles.actionBtn} ${styles.actionFlag}`}    onClick={() => setExpanded('flag')}>⚑ Flag</button>
      <button className={`${styles.actionBtn} ${styles.actionHold}`}    onClick={() => setExpanded('hold')}>⏸ Hold</button>
      <button className={`${styles.actionBtn} ${styles.actionInfo}`}    onClick={() => setExpanded('info')}>? Need Info</button>
      {!confirmReady && (
        <span style={{ fontSize: 10, color: 'var(--color-ink-faint)', marginLeft: 4 }}>
          Complete 3 criteria to enable Confirm
        </span>
      )}
    </div>
  );
}
