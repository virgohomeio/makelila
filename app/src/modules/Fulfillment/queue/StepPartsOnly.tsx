import { useState } from 'react';
import { markPartsReplacementShipped } from '../../../lib/orders';
import { replacementItemsLabel } from '../../../lib/replacementTags';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { Order as FullOrder } from '../../../lib/orders';
import styles from '../Fulfillment.module.css';

/** Stands in for Assign + Test on a replacement that carries no machine.
 *
 *  Those two steps are "pick a ready unit off the shelf" and "confirm its test
 *  report", and a replacement lid has neither. An operator who sent one here
 *  with "Ready to Ship" used to land on the unit picker — the one action they
 *  must not take, since assigning a machine would reserve it and flip it to
 *  shipped against an order that never contained it. So the row stuck, and the
 *  box often went out anyway with nothing in makeLILA saying so.
 *
 *  Parts go in the mail, and this is where someone says they did. */
export function StepPartsOnly({
  row,
  order,
  onShipped,
}: {
  row: FulfillmentQueueRow;
  order: { id: string; order_ref: string; customer_name: string; line_items: FullOrder['line_items'] };
  onShipped: () => void;
}) {
  const [carrier, setCarrier] = useState(row.carrier ?? '');
  const [tracking, setTracking] = useState(row.tracking_num ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ship = async () => {
    setBusy(true); setError(null);
    try {
      await markPartsReplacementShipped(order.id, { carrier, tracking_num: tracking });
      onShipped();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        Parts only — no machine to assign
      </h3>
      <p style={{ fontSize: 12, color: 'var(--color-ink-muted)', lineHeight: 1.55, marginBottom: 12 }}>
        {order.order_ref} is <strong>{replacementItemsLabel(order.line_items)}</strong> for{' '}
        {order.customer_name}. There is no unit to pick or test, so this skips straight to
        shipped — the same record reaching step&nbsp;6 leaves behind.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Carrier (optional)
          <input
            value={carrier}
            onChange={e => setCarrier(e.target.value)}
            placeholder="e.g. Canada Post"
            style={{
              padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
              border: '1px solid var(--color-border)', borderRadius: 4, background: '#fff',
            }}
          />
        </label>
        <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Tracking number (optional)
          <input
            value={tracking}
            onChange={e => setTracking(e.target.value)}
            placeholder="Leave blank if there is none"
            style={{
              padding: '6px 10px', fontSize: 12, fontFamily: 'inherit',
              border: '1px solid var(--color-border)', borderRadius: 4, background: '#fff',
            }}
          />
        </label>
      </div>

      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={() => void ship()} disabled={busy}>
          {busy ? 'Recording…' : '✓ Mark shipped'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 8, lineHeight: 1.5 }}>
        Stock isn&rsquo;t touched — these parts came off on-hand when the replacement was raised.
      </p>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
