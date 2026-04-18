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

type Banner = { variant: 'success' | 'error'; message: string } | null;

export function Detail({
  order,
  onAfterDisposition,
}: {
  order: Order;
  onAfterDisposition: () => void;
}) {
  const [banner, setBanner] = useState<Banner>(null);
  const dismissBanner = useCallback(() => setBanner(null), []);

  const wrap = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      setBanner({ variant: 'success', message: `${label} · ${order.customer_name}` });
      onAfterDisposition();
    } catch (err) {
      setBanner({
        variant: 'error',
        message: `Failed: ${(err as Error).message ?? 'unknown error'}`,
      });
    }
  };

  return (
    <section className={styles.detail}>
      <ConfirmBanner banner={banner} onDismiss={dismissBanner} />
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
