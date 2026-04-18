import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders } from '../../lib/orders';
import { Sidebar } from './Sidebar';
import { Detail } from './Detail';
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

  const afterDisposition = () => {
    const remaining = pending.filter(o => o.id !== orderId);
    if (remaining.length > 0) {
      navigate(`/order-review/${remaining[0].id}`);
    } else {
      navigate('/order-review');
    }
  };

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
      {selected ? (
        <Detail order={selected} onAfterDisposition={afterDisposition} />
      ) : (
        <section className={styles.empty}>
          {loading ? 'Loading…' : 'Select an order from the left to review.'}
        </section>
      )}
    </div>
  );
}
