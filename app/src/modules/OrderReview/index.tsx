import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useOrders, syncShopifyOrders } from '../../lib/orders';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import { Sidebar } from './Sidebar';
import { Detail } from './Detail';
import Templates from '../Templates';
import Upload from '../Upload';
import Reconcile from './Reconcile';
import { EmptyState } from '../../components/ui';
import styles from './OrderReview.module.css';

type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; imported: number; skipped: number }
  | { kind: 'error'; message: string };

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { all, pending, held, flagged, approved, replacement, cancelled, loading } = useOrders();
  // Cancelled orders sit outside `all` (they are out of the live queue), but
  // the Cancelled tab still has to be able to open one.
  const selected = orderId
    ? all.find(o => o.id === orderId) ?? cancelled.find(o => o.id === orderId) ?? null
    : null;
  const [view, setView] = useState<'orders' | 'reconcile' | 'templates' | 'upload'>('orders');
  // Syncing is a module-level action, not a list filter, so it lives in the
  // page header rather than inside the order rail's header.
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });

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

  const runSync = async () => {
    setSync({ kind: 'syncing' });
    try {
      const r = await syncShopifyOrders();
      setSync({ kind: 'done', imported: r.imported, skipped: r.skipped });
    } catch (e) {
      setSync({ kind: 'error', message: (e as Error).message });
    }
  };

  const liveCount = all.length;

  // Views (Orders / Templates / Upload) are a different navigational level
  // from the status tabs in the rail, so they no longer wear the same crimson
  // pill treatment those tabs use.
  const header = (
    <div className={styles.pageHead}>
      <div>
        <div className={styles.pageTitle}>Sales</div>
        <div className={styles.pageSub}>
          {loading
            ? 'Loading orders…'
            : `${liveCount} live order${liveCount === 1 ? '' : 's'} · ${pending.length} awaiting confirmation`}
        </div>
      </div>
      <div className={styles.pageHeadRight}>
        {view === 'orders' && (
          <span className={styles.syncRow}>
            <span className={styles.syncStatus}>
              {sync.kind === 'done' && `${sync.imported} new · ${sync.skipped} skipped`}
              {sync.kind === 'error' && (
                <span className={styles.syncError}>Sync failed: {sync.message}</span>
              )}
            </span>
            <button
              type="button"
              className={styles.syncBtn}
              onClick={() => void runSync()}
              disabled={sync.kind === 'syncing'}
            >
              {sync.kind === 'syncing' ? 'Syncing…' : '⟲ Sync from Shopify'}
            </button>
          </span>
        )}
        <div className={styles.viewChips}>
          <button
            type="button"
            className={`${styles.viewChip} ${view === 'orders' ? styles.viewChipActive : ''}`}
            onClick={() => setView('orders')}
            aria-pressed={view === 'orders'}
          >Orders</button>
          <button
            type="button"
            className={`${styles.viewChip} ${view === 'reconcile' ? styles.viewChipActive : ''}`}
            onClick={() => setView('reconcile')}
            aria-pressed={view === 'reconcile'}
            title="Pending orders whose customer already has a machine — say what actually happened to each"
          >Reconcile</button>
          <button
            type="button"
            className={`${styles.viewChip} ${view === 'templates' ? styles.viewChipActive : ''}`}
            onClick={() => setView('templates')}
            aria-pressed={view === 'templates'}
          >Templates</button>
          <button
            type="button"
            className={`${styles.viewChip} ${view === 'upload' ? styles.viewChipActive : ''}`}
            onClick={() => setView('upload')}
            aria-pressed={view === 'upload'}
          >Upload</button>
        </div>
      </div>
    </div>
  );

  if (view === 'reconcile') {
    return <div className={styles.salesRoot}>{header}<Reconcile /></div>;
  }

  if (view === 'templates') {
    return <div className={styles.salesRoot}>{header}<Templates /></div>;
  }

  if (view === 'upload') {
    return <div className={styles.salesRoot}>{header}<Upload /></div>;
  }

  // Mobile: single column. Sidebar (filter strip + order list) when no
  // selection; Detail with a back header when an order is selected.
  if (isMobile) {
    if (selected) {
      return (
        <div className={styles.salesRoot}>
          <div className={styles.layout}>
            <MobileBackHeader
              label={`${selected.order_ref} · ${selected.customer_name}`}
              onBack={() => navigate('/order-review')}
            />
            <Detail order={selected} onAfterDisposition={afterDisposition} />
          </div>
        </div>
      );
    }
    return (
      <div className={styles.salesRoot}>
        {header}
        <div className={styles.layout}>
          <Sidebar
            all={all}
            pending={pending}
            held={held}
            flagged={flagged}
            approved={approved}
            replacement={replacement}
            cancelled={cancelled}
            selectedId={null}
            onSelect={(id) => navigate(`/order-review/${id}`)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.salesRoot}>
      {header}
      <div className={styles.layout}>
        <Sidebar
          all={all}
          pending={pending}
          held={held}
          flagged={flagged}
          approved={approved}
          replacement={replacement}
          cancelled={cancelled}
          selectedId={orderId ?? null}
          onSelect={(id) => navigate(`/order-review/${id}`)}
        />
        {selected ? (
          <Detail order={selected} onAfterDisposition={afterDisposition} />
        ) : (
          <section className={styles.empty}>
            {loading ? 'Loading…' : (
              <EmptyState
                title="No order open"
                body="Pick an order from the list to check its address, freight and line items before it goes to Fulfillment."
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
