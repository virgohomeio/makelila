import { useCallback, useState } from 'react';
import type { Order } from '../../lib/orders';
import { disposition, needInfo, addOrderNote, orderUrgency } from '../../lib/orders';
import { useAuth } from '../../lib/auth';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import { NotesCard }    from './detail/NotesCard';
import { ActionBar }    from './detail/ActionBar';
import { ConfirmBanner } from './detail/ConfirmBanner';
import { ReadinessChecklist, canConfirm } from './detail/ReadinessChecklist';
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
  const { profile, user } = useAuth();
  const authorName = profile?.display_name ?? user?.email ?? 'Unknown';

  const wrap = async (
    label: string,
    fn: () => Promise<void>,
    noteLabel?: string,
    reason?: string,
  ) => {
    try {
      await fn();
      const trimmed = reason?.trim();
      if (noteLabel && trimmed) {
        await addOrderNote(order.id, authorName, `${noteLabel}: ${trimmed}`);
      }
      setBanner({ variant: 'success', message: `${label} · ${order.customer_name}` });
      onAfterDisposition();
    } catch (err) {
      setBanner({
        variant: 'error',
        message: `Failed: ${(err as Error).message ?? 'unknown error'}`,
      });
    }
  };

  const confirmReady = canConfirm(order);

  return (
    <section className={styles.detail}>
      <ConfirmBanner banner={banner} onDismiss={dismissBanner} />
      <ActionBar
        order={order}
        confirmReady={confirmReady}
        onApprove={() => wrap('Approved', () => disposition(order, 'approved'))}
        onFlag={(reason) => wrap('Flagged', () => disposition(order, 'flagged', reason), 'Flagged', reason)}
        onHold={(reason) => wrap('Held',    () => disposition(order, 'held',    reason), 'Held', reason)}
        onNeedInfo={(note) => wrap('Need-info logged', () => needInfo(order, note), 'Need info', note)}
      />
      <div className={styles.detailBody}>
        {(() => {
          const basis = order.placed_at ?? order.created_at;
          const u = orderUrgency(basis);
          if (!u.label) return null;
          const placed = basis ? new Date(basis).toLocaleDateString('en-US') : '—';
          return (
            <div className={`${styles.urgencyBanner} ${styles[u.severity]}`}>
              <strong>Placed {placed}</strong> · {u.days ?? '?'} day{u.days === 1 ? '' : 's'} ago · {u.label.includes('OVERDUE') ? 'OVERDUE' : u.label.includes('URGENT') ? 'URGENT — approve within 4 days' : 'OK — approve within 2 days (max 4)'}
            </div>
          );
        })()}
        <ReadinessChecklist order={order} />
        <CustomerCard order={order} />
        <AddressCard order={order} />
        <FreightCard order={order} />
        <LineItemsCard order={order} />
        <NotesCard order={order} />
      </div>
    </section>
  );
}
