import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders } from '../../lib/orders';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import { Sidebar } from './Sidebar';
import { Detail } from './Detail';
import Templates from '../Templates';
import styles from './OrderReview.module.css';

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { all, pending, held, flagged, approved, replacement, loading } = useOrders();
  const selected = orderId ? all.find(o => o.id === orderId) ?? null : null;
  const [view, setView] = useState<'orders' | 'templates'>('orders');

  // Desktop auto-loads the first pending order so the right pane isn't empty
  // on first paint. On mobile we keep the sidebar visible (no order selected)
  // so the operator chooses what to drill into — same primitive as the home
  // module picker. Tapping a row navigates to /order-review/:id.
  useEffect(() => {
    if (!isMobile && !loading && !orderId && pending.length > 0) {
      navigate(`/order-review/${pending[0].id}`, { replace: true });
    }
  }, [isMobile, loading, orderId, pending, navigate]);

  const afterDisposition = () => {
    const remaining = pending.filter(o => o.id !== orderId);
    if (remaining.length > 0) {
      navigate(`/order-review/${remaining[0].id}`);
    } else {
      navigate('/order-review');
    }
  };

  const viewChips = (
    <div className={styles.viewChips}>
      <button
        className={`${styles.viewChip} ${view === 'orders' ? styles.viewChipActive : ''}`}
        onClick={() => setView('orders')}
      >Orders</button>
      <button
        className={`${styles.viewChip} ${view === 'templates' ? styles.viewChipActive : ''}`}
        onClick={() => setView('templates')}
      >Templates</button>
    </div>
  );

  if (view === 'templates') {
    return (
      <div>
        {viewChips}
        <Templates />
      </div>
    );
  }

  // Mobile: single column. Sidebar (filter strip + order list) when no
  // selection; Detail with a back header when an order is selected.
  if (isMobile) {
    if (selected) {
      return (
        <div className={styles.layout}>
          <MobileBackHeader
            label={`#${selected.order_ref} · ${selected.customer_name}`}
            onBack={() => navigate('/order-review')}
          />
          <Detail order={selected} onAfterDisposition={afterDisposition} />
        </div>
      );
    }
    return (
      <div className={styles.layout}>
        {viewChips}
        <Sidebar
          all={all}
          pending={pending}
          held={held}
          flagged={flagged}
          approved={approved}
          replacement={replacement}
          selectedId={null}
          onSelect={(id) => navigate(`/order-review/${id}`)}
        />
      </div>
    );
  }

  return (
    <div>
      {viewChips}
      <div className={styles.layout}>
        <Sidebar
          all={all}
          pending={pending}
          held={held}
          flagged={flagged}
          approved={approved}
          replacement={replacement}
          selectedId={orderId ?? null}
          onSelect={(id) => navigate(`/order-review/${id}`)}
        />
        {selected ? (
          <Detail order={selected} onAfterDisposition={afterDisposition} />
        ) : (
          <section className={styles.empty}>
            {loading ? 'Loading…' : 'Select an order from the left to review.'}
          </section>
        )}
      </div>
    </div>
  );
}
