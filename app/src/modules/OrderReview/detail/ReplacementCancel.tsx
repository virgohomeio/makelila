import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { cancelReplacementOrder } from '../../../lib/orders';
import { useTicketBrief } from '../../../lib/service';
import styles from '../OrderReview.module.css';

/** Cancel action for a pending replacement order, shown in the replacement
 *  banner. Enabled only once the associated support ticket is closed (or there
 *  is no linked ticket) and the order hasn't shipped. On cancel the reserved
 *  stock is released and the order is deleted, which removes it from both the
 *  Sales (Order Review) and Service replacement lists. */
export function ReplacementCancel({ order, onCancelled, onError }: {
  order: Order;
  onCancelled: () => void;
  onError: (message: string) => void;
}) {
  const { status, ticketNumber, loading } = useTicketBrief(order.linked_ticket_id ?? null);
  const [busy, setBusy] = useState(false);

  const shipped = !!(order.shipped_at || order.delivered_at);
  const ticketClosed = !order.linked_ticket_id || status === 'closed';
  const canCancel = !shipped && ticketClosed && !loading && !busy;

  const run = async () => {
    const tick = ticketNumber ? ` (ticket ${ticketNumber})` : '';
    if (!window.confirm(
      `Cancel replacement ${order.order_ref}${tick}?\n\n`
      + 'Reserved stock will be released and it will be removed from the Sales and '
      + 'Service replacement lists. This cannot be undone.',
    )) return;
    setBusy(true);
    try {
      await cancelReplacementOrder(order.id);
      onCancelled(); // order deleted → navigate away (component unmounts)
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  let reason: string | null = null;
  if (shipped) reason = 'Already shipped — cannot cancel.';
  else if (loading) reason = 'Checking ticket status…';
  else if (!ticketClosed) reason = `Close the associated ticket ${ticketNumber ?? ''} first (currently: ${status ?? 'unknown'}).`;

  return (
    <span className={styles.replCancelWrap}>
      <button
        type="button"
        className={styles.replCancelBtn}
        onClick={() => void run()}
        disabled={!canCancel}
        title={reason ?? 'Cancel this replacement and release its reserved stock'}
      >
        {busy ? 'Cancelling…' : 'Cancel replacement'}
      </button>
      {reason && <span className={styles.replCancelHint}>⚠ {reason}</span>}
    </span>
  );
}
