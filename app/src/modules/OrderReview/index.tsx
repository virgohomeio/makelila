import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders } from '../../lib/orders';
import { Sidebar } from './Sidebar';
import styles from './OrderReview.module.css';

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { all, pending, held, flagged, loading } = useOrders();
  const selected = orderId ? all.find(o => o.id === orderId) ?? null : null;

  useEffect(() => {
    if (!loading && !orderId && pending.length > 0) {
      navigate(`/order-review/${pending[0].id}`, { replace: true });
    }
  }, [loading, orderId, pending, navigate]);

  return (
    <div className={styles.layout}>
      <Sidebar
        all={all}
        pending={pending}
        held={held}
        flagged={flagged}
        selectedId={orderId ?? null}
        onSelect={(id) => navigate(`/order-review/${id}`)}
      />
      <section>
        {selected ? (
          <div className={styles.empty}>Selected: {selected.order_ref}</div>
        ) : (
          <div className={styles.empty}>Select an order from the left to review.</div>
        )}
      </section>
    </div>
  );
}
