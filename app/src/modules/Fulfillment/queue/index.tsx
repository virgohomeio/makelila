import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useFulfillmentQueue } from '../../../lib/fulfillment';
import { QueueSidebar } from './QueueSidebar';
import { QueueHeader } from './QueueHeader';
import { StepAssign } from './StepAssign';
import { StepTest } from './StepTest';
import { StepLabel } from './StepLabel';
import { StepDock } from './StepDock';
import styles from '../Fulfillment.module.css';

type Order = {
  id: string;
  order_ref: string;
  customer_name: string;
  city: string;
  region_state: string | null;
  country: 'US' | 'CA';
};

export default function Queue() {
  const { ready, fulfilled, loading } = useFulfillmentQueue();
  const rows = useMemo(() => [...ready, ...fulfilled], [ready, fulfilled]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  // Fetch orders referenced by the queue rows (one-shot; orders rarely change once approved)
  useEffect(() => {
    if (rows.length === 0) return;
    const ids = Array.from(new Set(rows.map(r => r.order_id)));
    void supabase
      .from('orders')
      .select('id, order_ref, customer_name, city, region_state, country')
      .in('id', ids)
      .then(({ data }) => setOrders((data as Order[]) ?? []));
  }, [rows]);

  const orderLookup = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);

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
            {selected.step === 3 && <StepLabel row={selected} />}
            {selected.step === 4 && <StepDock row={selected} />}
            {selected.step >= 5 && <div>Step {selected.step} — UI coming in Tasks 17–18</div>}
          </>
        )}
      </section>
    </div>
  );
}
