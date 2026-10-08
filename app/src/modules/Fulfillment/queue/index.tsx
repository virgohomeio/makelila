import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { useFulfillmentQueue, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import type { OrderStatus, Order as FullOrder } from '../../../lib/orders';
import { QueueSidebar } from './QueueSidebar';
import { QueueHeader } from './QueueHeader';
import { StepAssign } from './StepAssign';
import { StepPartsOnly } from './StepPartsOnly';
import { StepTest } from './StepTest';
import { StepLabel } from './StepLabel';
import { StepDock } from './StepDock';
import { StepEmail } from './StepEmail';
import { StepFulfilled } from './StepFulfilled';
import { GoorooshipDailyBatch } from './GoorooshipDailyBatch';
import { EmptyState } from '../../../components/ui';
import { indexRefundFlags, useRefundMarks } from '../../../lib/refundedOrders';
import { isPartsOnlyReplacement } from '../../../lib/replacementTags';
import { goorooshipSend, splitAwaitingPickup, useGoorooshipSends } from '../../../lib/pickupQueue';
import { useEzTransRowIds } from '../../../lib/eztrans';
import {
  indexShippedQueueRows, shippedMarkHeading, shippedMarkTitle, useShippedEvidence,
  type ShippedMark,
} from '../../../lib/shippedOrders';
import styles from '../Fulfillment.module.css';

type Order = {
  id: string;
  order_ref: string;
  kind: 'sale' | 'replacement';
  customer_name: string;
  customer_email: string | null;
  // Address + phone are here for the EZ Trans packing list, which has to carry
  // the customer's full name, full address, email and phone. select('*')
  // already returned them.
  customer_phone: string | null;
  address_line: string | null;
  address_line2: string | null;
  city: string;
  region_state: string | null;
  postal_code: string | null;
  country: 'US' | 'CA';
  status: OrderStatus;
  placed_at: string | null;
  created_at: string;
  // When the customer confirmed the box arrived. Written by the card's
  // "Shipment Received" button; it is the whole basis of the Received rail.
  // select('*') already returns it.
  delivered_at: string | null;
  // Replacements only: what is actually in the box, and the case it came from.
  // select('*') already returns these; they were simply never read here, which
  // is why the card called a $24 lid a LILA Pro.
  line_items: FullOrder['line_items'];
  awaiting_batch_id: string | null;
  linked_ticket_id: string | null;
  // 'open' is an operator saying this order still owes the customer a machine,
  // and it is what keeps a reship out of the already-shipped rail even though
  // its first machine is stamped and shipped. select('*') returns it.
  reconcile_outcome: string | null;
};

export default function Queue() {
  const { ready, fulfilled, loading, refresh } = useFulfillmentQueue();
  const { marks: refundMarks } = useRefundMarks();
  const { evidence: shippedEvidence } = useShippedEvidence();
  // Which orders the 3PL has already been told about — the third of the three
  // things that move a row out of Ready to ship and into To be picked up.
  const { sends: goorooshipSends, refresh: refreshSends } = useGoorooshipSends();
  // Which of those rows EZ Trans is picking, which is what decides whether the
  // Goorooship email is part of their handoff at all. Asked for the whole rail
  // at once rather than per row: the answer gates step 3's button on the open
  // order AND sorts every other row between the two rails.
  const { ezTransRowIds, loading: ezTransLoading } = useEzTransRowIds(ready);
  // One predicate, used by both, so the button and the rail cannot disagree
  // about an order. Unknown reads as EZ Trans — see lib/pickupQueue.ts.
  const isEzTransRow = useCallback(
    (r: { id: string }) => ezTransLoading || ezTransRowIds.has(r.id),
    [ezTransLoading, ezTransRowIds],
  );
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

  // Queue rows that are no longer owed a box: a sale whose machine is already
  // at the customer, or a replacement whose support case is closed. The queue
  // only closes a row out when someone walks it to step 6 by hand, so anything
  // settled another way just sits in Ready to ship — six sale orders were doing
  // that on 2026-09-04 and five replacements on 2026-09-09, months after the
  // fact. See lib/shippedOrders.ts.
  const shippedMarks = useMemo(
    () => indexShippedQueueRows(ready, orderLookup, shippedEvidence),
    [ready, orderLookup, shippedEvidence],
  );

  // Bumped after an arrival is recorded. The orders behind the queue are read
  // once (they rarely change after approval), so without this the row would
  // keep rendering under Shipped with delivered_at still null locally.
  const [ordersEpoch, setOrdersEpoch] = useState(0);

  const { readyRows, pickupRows, shippedRows, receivedRows } = useMemo(() => {
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
    // Labelled, docked and already emailed to Goorooship: waiting on the
    // carrier, not on us. Split off the sorted rail so both halves keep pick
    // order, and split rather than filtered so nothing goes missing.
    const { ready: stillOurs, pickup } = splitAwaitingPickup(readySorted, goorooshipSends, isEzTransRow);
    // Left unsorted on purpose: the sidebar buckets this tab by the month each
    // box went out and orders it newest-first (queue/shippedMonths.ts). Sorting
    // by order ref here only to have it thrown away read like the real order.
    // The end of the line. A box having left the dock and the customer having
    // it are two different claims, so Received is its own rail rather than a
    // badge on Shipped: the carrier's "delivered" scan is not what fills it —
    // an operator confirming the arrival is.
    const everythingShipped = [...fulfilled, ...alreadyShipped];
    const receivedOf = (r: FulfillmentQueueRow) =>
      orderLookup.get(r.order_id)?.delivered_at ?? null;
    return {
      readyRows: stillOurs,
      pickupRows: pickup,
      shippedRows: everythingShipped.filter(r => !receivedOf(r)),
      receivedRows: everythingShipped.filter(r => !!receivedOf(r)),
    };
  }, [ready, fulfilled, orderLookup, shippedMarks, goorooshipSends, isEzTransRow]);

  const allRows = useMemo(
    () => [...readyRows, ...pickupRows, ...shippedRows, ...receivedRows],
    [readyRows, pickupRows, shippedRows, receivedRows],
  );

  // Arrival dates by queue row id — buckets the Received rail by month and
  // dates each of its cards.
  const receivedAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of receivedRows) {
      const at = orderLookup.get(r.order_id)?.delivered_at;
      if (at) m.set(r.id, at);
    }
    return m;
  }, [receivedRows, orderLookup]);

  // A queued order whose money has already gone back should never be picked.
  // Shipped rows are history and are left unbadged — the box is gone, and that
  // is the returns team's problem, not the picker's.
  const refundFlags = useMemo(
    () => indexRefundFlags(
      [...readyRows, ...pickupRows].flatMap(r => orderLookup.get(r.order_id) ?? []),
      refundMarks,
    ),
    [readyRows, pickupRows, orderLookup, refundMarks],
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
  }, [ready, fulfilled, ordersEpoch]);

  // Default-select first row on load. Skipped while a notice is showing so the
  // confirmation isn't blown away by an auto-select the operator didn't ask for.
  // Selects from readyRows, not ready: opening on an already-shipped order
  // would put the Assign step in front of the picker first thing.
  useEffect(() => {
    if (!selectedId && !notice && readyRows.length > 0) setSelectedId(readyRows[0].id);
  }, [readyRows, selectedId, notice]);

  const selected = allRows.find(r => r.id === selectedId) ?? null;
  const selectedOrder = selected ? orderLookup.get(selected.order_id) : null;
  const partsOnly = !!selectedOrder
    && selectedOrder.kind === 'replacement'
    && isPartsOnlyReplacement(selectedOrder);

  // Everything the Goorooship footer needs to name a box and address it. The
  // orders the page already fetched, narrowed rather than re-read.
  const batchOrders = useMemo(() => {
    const m = new Map<string, {
      id: string; order_ref: string; customer_name: string; country?: string | null;
    }>();
    // country rides along because it is what decides whether a shipment carries
    // a pesticide worksheet — without it the footer would promise the wrong
    // documents.
    for (const o of orders) m.set(o.id, {
      id: o.id, order_ref: o.order_ref, customer_name: o.customer_name, country: o.country,
    });
    return m;
  }, [orders]);

  return (
    <div className={styles.queuePage}>
      <div className={styles.queueLayout}>
        <QueueSidebar
          readyRows={readyRows}
          pickupRows={pickupRows}
          shippedRows={shippedRows}
          receivedRows={receivedRows}
          receivedAt={receivedAt}
          orderLookup={orderLookup}
          refundFlags={refundFlags}
          shippedMarks={shippedMarks}
          goorooshipSends={goorooshipSends}
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
            // Keyed on the row, so picking a different order in the sidebar
            // builds this pane fresh instead of handing the old one new props.
            // Every panel below holds state that is true of exactly one order —
            // a half-typed tracking number, a dock checkbox, "this just
            // shipped" — and without a remount all of it is inherited by
            // whichever order is clicked next.
            <Fragment key={selected.id}>
              <QueueHeader
                row={selected}
                order={selectedOrder}
                onRemoved={message => { setNotice(message); setSelectedId(null); }}
                // A rebook moves the row between rails as well as steps: its
                // Goorooship send is retired, so the badge and the "To be
                // picked up" split have to be re-read too.
                onStepChanged={() => { void refresh(); void refreshSends(); }}
                // A row can be shipped without ever reaching step 6 — see
                // shippedMarks above. Those are receivable too.
                shipped={shippedMarks.has(selected.id)}
                onReceived={() => setOrdersEpoch(e => e + 1)}
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
                  {/* Assign and Test are both about a machine: pick one off the
                      shelf, confirm its test report. A replacement carrying only
                      parts has neither, and the picker is the one thing an
                      operator holding a lid must not use — assigning a unit would
                      reserve it and mark it shipped against an order that never
                      contained it. Those two steps become "put it in the mail and
                      say so"; Label, Dock and Email still apply to a parts box,
                      so they are left alone. */}
                  {selected.step === 1 && (partsOnly
                    ? <StepPartsOnly row={selected} order={selectedOrder} onShipped={() => { void refresh(); }} />
                    : <StepAssign row={selected} order={selectedOrder} />)}
                  {selected.step === 2 && (partsOnly
                    ? <StepPartsOnly row={selected} order={selectedOrder} onShipped={() => { void refresh(); }} />
                    : <StepTest row={selected} />)}
                  {selected.step === 3 && (
                    <StepLabel
                      /* Keyed on the row, so none of step 3's state — a typed
                         tracking number, a confirmed-booking banner — follows
                         the operator to the next order they click. The panels
                         under it are seeded from the row on mount, and an
                         unkeyed step is how #1203 wore #1190's pill. */
                      key={selected.id}
                      row={selected}
                      order={selectedOrder}
                      isEzTrans={isEzTransRow(selected)}
                      goorooshipSentAt={goorooshipSend(selected, goorooshipSends)?.at ?? null}
                      onBatchChanged={() => { void refresh(); void refreshSends(); }}
                    />
                  )}
                  {selected.step === 4 && <StepDock row={selected} />}
                  {selected.step === 5 && <StepEmail row={selected} order={selectedOrder} onSent={() => { void refresh(); }} />}
                  {selected.step === 6 && <StepFulfilled row={selected} order={selectedOrder} />}
                </>
              )}
            </Fragment>
          )}
        </section>
      </div>
      {/* EZ Trans asked for one email a day rather than one per box, so the
          end-of-day send lives at the bottom of the page the orders are worked
          from rather than inside any one order's step. */}
      <GoorooshipDailyBatch
        rows={allRows}
        orders={batchOrders}
        onSent={() => { void refresh(); void refreshSends(); }}
      />
    </div>
  );
}

/** Replaces the step UI on a row that is no longer owed a box — the machine has
 *  already gone out, or the case behind a replacement is closed. The steps it
 *  stands in for are Assign and Test — i.e. "pick a machine for this order" —
 *  which is the one thing nobody should do here. */
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
        {shippedMarkHeading(mark)}
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
