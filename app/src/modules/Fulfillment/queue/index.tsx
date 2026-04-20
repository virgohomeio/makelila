import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useFulfillmentQueue, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { QueueSidebar } from './QueueSidebar';
import { QueueHeader } from './QueueHeader';
import { StepAssign } from './StepAssign';
import { StepTest } from './StepTest';
import { StepLabel } from './StepLabel';
import { StepDock } from './StepDock';
import { StepEmail } from './StepEmail';
import { StepFulfilled } from './StepFulfilled';
import styles from '../Fulfillment.module.css';

type Order = {
  id: string;
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
  placed_at: string | null;
};

export default function Queue() {
  const { ready, fulfilled, loading } = useFulfillmentQueue();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  const orderLookup = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

  const rows = useMemo(() => {
    const byRef = (a: FulfillmentQueueRow, b: FulfillmentQueueRow) => {
      const refA = orderLookup.get(a.order_id)?.order_ref ?? '';
      const refB = orderLookup.get(b.order_id)?.order_ref ?? '';
      return refA.localeCompare(refB);
    };
    // Priority rows (sales-flagged expedites) float to the top of Ready.
    const readySorted = [...ready].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return byRef(a, b);
    });
    return [...readySorted, ...[...fulfilled].sort(byRef)];
  }, [ready, fulfilled, orderLookup]);

  // Fetch orders referenced by the queue rows (one-shot; orders rarely change once approved)
  useEffect(() => {
    const ids = Array.from(new Set([...ready, ...fulfilled].map(r => r.order_id)));
    if (ids.length === 0) return;
    void supabase
      .from('orders')
      .select('id, order_ref, customer_name, customer_email, city, region_state, country, placed_at')
      .in('id', ids)
      .then(({ data }) => setOrders((data as Order[]) ?? []));
  }, [ready, fulfilled]);

  // Default-select first row on load
  useEffect(() => {
    if (!selectedId && ready.length > 0) setSelectedId(ready[0].id);
  }, [ready, selectedId]);

  const selected = rows.find(r => r.id === selectedId) ?? null;
  const selectedOrder = selected ? orderLookup.get(selected.order_id) : null;

  return (
    <div className={styles.queueLayout}>
      <QueueSidebar
        rows={rows}
        orderLookup={orderLookup}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <section className={styles.detail}>
        {loading ? (
          <div>Loading…</div>
        ) : !selected || !selectedOrder ? (
          <div>Select a queued order from the left.</div>
        ) : (
          <>
            <QueueHeader row={selected} order={selectedOrder} />
            {selected.step === 1 && <StepAssign row={selected} />}
            {selected.step === 2 && <StepTest row={selected} />}
            {selected.step === 3 && <StepLabel row={selected} country={selectedOrder.country} />}
            {selected.step === 4 && <StepDock row={selected} />}
            {selected.step === 5 && <StepEmail row={selected} order={selectedOrder} />}
            {selected.step === 6 && <StepFulfilled row={selected} order={selectedOrder} />}
          </>
        )}
      </section>
    </div>
  );
}
