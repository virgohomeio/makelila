import { useCallback, useState } from 'react';
import type { Order } from '../../lib/orders';
import { disposition, needInfo } from '../../lib/orders';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import { NotesCard }    from './detail/NotesCard';
import { ActionBar }    from './detail/ActionBar';
import { ConfirmBanner } from './detail/ConfirmBanner';
import styles from './OrderReview.module.css';

export function Detail({
  order,
  onAfterDisposition,
}: {
  order: Order;
  onAfterDisposition: () => void;
}) {
  const [banner, setBanner] = useState<string | null>(null);
  const dismissBanner = useCallback(() => setBanner(null), []);

  const wrap = async (label: string, fn: () => Promise<void>) => {
    await fn();
    setBanner(`${label} · ${order.customer_name}`);
    onAfterDisposition();
  };

  return (
    <section className={styles.detail}>
      <ConfirmBanner message={banner} onDismiss={dismissBanner} />
      <ActionBar
        order={order}
        onApprove={() => wrap('Approved', () => disposition(order, 'approved'))}
        onFlag={(reason) => wrap('Flagged', () => disposition(order, 'flagged', reason))}
        onHold={(reason) => wrap('Held',    () => disposition(order, 'held',    reason))}
        onNeedInfo={(note) => wrap('Need-info logged', () => needInfo(order, note))}
      />
      <div className={styles.detailBody}>
        <CustomerCard order={order} />
        <AddressCard order={order} />
        <FreightCard order={order} />
        <LineItemsCard order={order} />
        <NotesCard order={order} />
      </div>
    </section>
  );
}
