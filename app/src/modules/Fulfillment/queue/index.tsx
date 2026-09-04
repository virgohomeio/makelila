import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useFulfillmentQueue, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { OrderStatus, Order as FullOrder } from '../../../lib/orders';
import { QueueSidebar } from './QueueSidebar';
import { QueueHeader } from './QueueHeader';
import { StepAssign } from './StepAssign';
import { StepTest } from './StepTest';
import { StepLabel } from './StepLabel';
import { StepDock } from './StepDock';
import { StepEmail } from './StepEmail';
import { StepFulfilled } from './StepFulfilled';
import { EmptyState } from '../../../components/ui';
import { indexRefundFlags, useRefundMarks } from '../../../lib/refundedOrders';
import {
  indexShippedQueueRows, shippedMarkTitle, useShippedEvidence, type ShippedMark,
} from '../../../lib/shippedOrders';
import styles from '../Fulfillment.module.css';

type Order = {
  id: string;
  order_ref: string;
  kind: 'sale' | 'replacement';
  customer_name: string;
  customer_email: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  status: OrderStatus;
  placed_at: string | null;
  created_at: string;
  // Replacements only: what is actually in the box, and the case it came from.
  // select('*') already returns these; they were simply never read here, which
  // is why the card called a $24 lid a LILA Pro.
  line_items: FullOrder['line_items'];
  awaiting_batch_id: string | null;
  linked_ticket_id: string | null;
};

export default function Queue() {
  const { ready, fulfilled, loading } = useFulfillmentQueue();
  const { marks: refundMarks } = useRefundMarks();
  const { evidence: shippedEvidence } = useShippedEvidence();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  // What happened to the row that just left the queue (cancelled / moved back).
  // The row disappears via realtime, so without this the detail pane would
  // silently fall back to "Select a queued order" with no confirmation.
  const [notice, setNotice] = useState<string | null>(null);

  const orderLookup = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  // Queue rows whose machine is already at the customer. The queue only closes
  // a row out when someone walks it to step 6 by hand, so an order shipped any
  // other way just sits in Ready to ship — six sale orders were doing exactly
  // that on 2026-09-04, months after delivery. See lib/shippedOrders.ts.
  const shippedMarks = useMemo(
    () => indexShippedQueueRows(ready, orderLookup, shippedEvidence),
    [ready, orderLookup, shippedEvidence],
  );

  const { readyRows, shippedRows } = useMemo(() => {
    const byRef = (a: FulfillmentQueueRow, b: FulfillmentQueueRow) => {
      const refA = orderLookup.get(a.order_id)?.order_ref ?? '';
      const refB = orderLookup.get(b.order_id)?.order_ref ?? '';
      return refA.localeCompare(refB);
    };
    // Priority rows (sales-flagged expedites) float to the top of Ready.
    const readySorted = [...ready]
      .filter(r => !shippedMarks.has(r.id))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        return byRef(a, b);
      });
    // Moved, not hidden: the row still has an order behind it that someone has
    // to close out, and Shipped is where they will go looking for it.
    const alreadyShipped = ready.filter(r => shippedMarks.has(r.id));
    return {
      readyRows: readySorted,
      shippedRows: [...fulfilled, ...alreadyShipped].sort(byRef),
    };
  }, [ready, fulfilled, orderLookup, shippedMarks]);

  const allRows = useMemo(() => [...readyRows, ...shippedRows], [readyRows, shippedRows]);

  // A queued order whose money has already gone back should never be picked.
  // Shipped rows are history and are left unbadged — the box is gone, and that
  // is the returns team's problem, not the picker's.
  const refundFlags = useMemo(
    () => indexRefundFlags(readyRows.flatMap(r => orderLookup.get(r.order_id) ?? []), refundMarks),
    [readyRows, orderLookup, refundMarks],
  );

  // Fetch orders referenced by the queue rows (one-shot; orders rarely change once approved)
  useEffect(() => {
    const ids = Array.from(new Set([...ready, ...fulfilled].map(r => r.order_id)));
    if (ids.length === 0) return;
    // select('*') is tolerant of missing columns (placed_at may be unmigrated
    // on some environments; we fall back to created_at for the Due pill).
    void supabase
      .from('orders')
      .select('*')
      .in('id', ids)
      .then(({ data, error }) => {
        if (error) { console.error('Queue orders fetch failed:', error); return; }
        setOrders((data as Order[]) ?? []);
      });
  }, [ready, fulfilled]);

  // Default-select first row on load. Skipped while a notice is showing so the
  // confirmation isn't blown away by an auto-select the operator didn't ask for.
  // Selects from readyRows, not ready: opening on an already-shipped order
  // would put the Assign step in front of the picker first thing.
  useEffect(() => {
    if (!selectedId && !notice && readyRows.length > 0) setSelectedId(readyRows[0].id);
  }, [readyRows, selectedId, notice]);

  const selected = allRows.find(r => r.id === selectedId) ?? null;
  const selectedOrder = selected ? orderLookup.get(selected.order_id) : null;

  return (
    <div className={styles.queueLayout}>
      <QueueSidebar
        readyRows={readyRows}
        shippedRows={shippedRows}
        orderLookup={orderLookup}
        refundFlags={refundFlags}
        shippedMarks={shippedMarks}
        selectedId={selectedId}
        onSelect={id => { setNotice(null); setSelectedId(id); }}
      />
      <section className={styles.detail}>
        {loading ? (
          <div>Loading…</div>
        ) : !selected || !selectedOrder ? (
          <div>
            {notice && <div className={styles.queueNotice}>✓ {notice}</div>}
            {/* Was a bare sentence set flush to the top-left of a 1000px-tall
                empty pane. It now sits in the shared EmptyState, so this
                reads the same as every other "nothing selected" pane. */}
            <EmptyState
              title="No order open"
              body="Pick an order from the queue to test it, dock it, print its label and send the shipping email."
            />
          </div>
        ) : (
          <>
            <QueueHeader
              row={selected}
              order={selectedOrder}
              onRemoved={message => { setNotice(message); setSelectedId(null); }}
            />
            {shippedMarks.has(selected.id) ? (
              // Ahead of the pause banner: "we already sent this" outranks
              // "fulfillment is paused" for anyone holding a second machine.
              <AlreadyShippedBanner
                mark={shippedMarks.get(selected.id)!}
                orderId={selectedOrder.id}
              />
            ) : selectedOrder.status !== 'approved' && selected.step < 6 ? (
              <PauseBanner status={selectedOrder.status} orderId={selectedOrder.id} />
            ) : (
              <>
                {selected.step === 1 && <StepAssign row={selected} />}
                {selected.step === 2 && <StepTest row={selected} />}
                {selected.step === 3 && <StepLabel row={selected} country={selectedOrder.country} />}
                {selected.step === 4 && <StepDock row={selected} />}
                {selected.step === 5 && <StepEmail row={selected} order={selectedOrder} />}
                {selected.step === 6 && <StepFulfilled row={selected} order={selectedOrder} />}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** Replaces the step UI on a row whose machine has already gone out. The steps
 *  it stands in for are Assign and Test — i.e. "pick a machine for this order"
 *  — which is the one thing nobody should do here. */
function AlreadyShippedBanner({ mark, orderId }: { mark: ShippedMark; orderId: string }) {
  return (
    <div style={{
      border: '1.5px solid var(--color-warning-border)',
      background: 'var(--color-warning-bg)',
      borderRadius: 8, padding: '16px 18px',
    }}>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--color-warning)',
        marginBottom: 8, letterSpacing: '0.3px',
      }}>
        ALREADY SHIPPED — DO NOT PACK
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-ink-muted)', lineHeight: 1.55, marginBottom: 12 }}>
        {shippedMarkTitle(mark)} This row was never walked to step 6, which is
        why it stayed in the queue.
      </div>
      <Link
        to={`/order-review/${orderId}`}
        style={{
          display: 'inline-block', background: '#fff', color: 'var(--color-crimson)',
          border: '1.5px solid var(--color-crimson)', padding: '7px 16px',
          borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: 'none',
        }}
      >Open in Order Review →</Link>
    </div>
  );
}

function PauseBanner({ status, orderId }: { status: OrderStatus; orderId: string }) {
  const label = status === 'flagged' ? '⚑ Flagged' : status === 'held' ? '⏸ Held' : '• ' + status;
  const copy = status === 'flagged'
    ? 'This order was flagged after being confirmed. Fulfillment is paused until Order Review clears the flag or re-approves the order.'
    : status === 'held'
      ? 'This order is currently on hold. Fulfillment is paused until Order Review releases the hold.'
      : 'This order is not in an approved state. Fulfillment is paused.';
  return (
    <div style={{
      border: '1.5px solid var(--color-error-border)',
      background: 'var(--color-error-bg)',
      borderRadius: 8, padding: '16px 18px',
    }}>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--color-error)',
        marginBottom: 8, letterSpacing: '0.3px',
      }}>
        {label.toUpperCase()} — FULFILLMENT PAUSED
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-ink-muted)', lineHeight: 1.55, marginBottom: 12 }}>
        {copy}
      </div>
      <Link
        to={`/order-review/${orderId}`}
        style={{
          display: 'inline-block', background: '#fff', color: 'var(--color-crimson)',
          border: '1.5px solid var(--color-crimson)', padding: '7px 16px',
          borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: 'none',
        }}
      >Open in Order Review →</Link>
    </div>
  );
}
