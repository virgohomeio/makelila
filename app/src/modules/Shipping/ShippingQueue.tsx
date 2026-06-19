import { useState } from 'react';
import { useShippingOrders, type ShippingOrderRow, type ShipmentStatus } from '../../lib/shipping';
import styles from './Shipping.module.css';

type Filter = 'ready' | 'shipped' | 'all';

function statusBadgeClass(status: ShipmentStatus | null): string {
  const map: Record<string, string> = {
    null: styles.statusReady,
    booked: styles.statusBooked,
    in_transit: styles.statusInTransit,
    delivered: styles.statusDelivered,
    exception: styles.statusException,
    missing: styles.statusMissing,
    cancelled: styles.statusCancelled,
  };
  return map[status ?? 'null'] ?? styles.statusBooked;
}

function statusLabel(status: ShipmentStatus | null): string {
  if (!status) return 'Ready to Ship';
  return { booked: 'Booked', in_transit: 'In Transit', delivered: 'Delivered',
           exception: 'Exception', missing: 'Missing', cancelled: 'Cancelled' }[status] ?? status;
}

function filterOrders(orders: ShippingOrderRow[], filter: Filter): ShippingOrderRow[] {
  if (filter === 'ready')   return orders.filter(o => o.shipment_status === null);
  if (filter === 'shipped') return orders.filter(o => o.shipment_status !== null && o.shipment_status !== 'cancelled');
  return orders;
}

type Props = {
  selectedOrderId: string | null;
  onSelect: (orderId: string) => void;
};

export function ShippingQueue({ selectedOrderId, onSelect }: Props) {
  const { orders, loading } = useShippingOrders();
  const [filter, setFilter] = useState<Filter>('ready');

  const visible = filterOrders(orders, filter);

  const readyCount   = orders.filter(o => o.shipment_status === null).length;
  const shippedCount = orders.filter(o => o.shipment_status !== null && o.shipment_status !== 'cancelled').length;

  return (
    <div className={styles.queue}>
      <div className={styles.queueHeader}>Shipping</div>
      <div className={styles.chips}>
        <button
          className={`${styles.chip} ${filter === 'ready'   ? styles.chipActive : ''}`}
          onClick={() => setFilter('ready')}
        >Ready ({readyCount})</button>
        <button
          className={`${styles.chip} ${filter === 'shipped' ? styles.chipActive : ''}`}
          onClick={() => setFilter('shipped')}
        >Shipped ({shippedCount})</button>
        <button
          className={`${styles.chip} ${filter === 'all'     ? styles.chipActive : ''}`}
          onClick={() => setFilter('all')}
        >All</button>
      </div>
      <div className={styles.orderList}>
        {loading && <div className={styles.empty}>Loading…</div>}
        {!loading && visible.length === 0 && (
          <div className={styles.empty}>No orders</div>
        )}
        {visible.map(o => (
          <div
            key={o.order_id}
            className={`${styles.orderItem} ${selectedOrderId === o.order_id ? styles.orderItemActive : ''}`}
            onClick={() => onSelect(o.order_id)}
          >
            <div className={styles.orderRef}>{o.order_ref}</div>
            <div className={styles.orderMeta}>{o.customer_name}</div>
            <div className={styles.orderMeta}>{o.city}{o.region_state ? `, ${o.region_state}` : ''}</div>
            <span className={`${styles.statusBadge} ${statusBadgeClass(o.shipment_status)}`}>
              {statusLabel(o.shipment_status)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
