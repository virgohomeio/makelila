import { useNavigate, useParams } from 'react-router-dom';
import { ShippingQueue } from './ShippingQueue';
import { ShippingTab }   from './tabs/ShippingTab';
import { TrackingTab }   from './tabs/TrackingTab';
import { InvoicesTab }   from './tabs/InvoicesTab';
import { ClaimsTab }     from './tabs/ClaimsTab';
import styles from './Shipping.module.css';

type Tab = 'shipping' | 'tracking' | 'invoices' | 'claims';
const VALID_TABS: Tab[] = ['shipping', 'tracking', 'invoices', 'claims'];

export default function Shipping() {
  const { orderId, tab } = useParams<{ orderId?: string; tab?: string }>();
  const navigate = useNavigate();

  const activeTab: Tab = (VALID_TABS.includes(tab as Tab) ? tab : 'shipping') as Tab;

  function handleOrderSelect(id: string) {
    navigate(`/shipping/${id}/shipping`);
  }

  function handleTabChange(t: Tab) {
    if (!orderId) return;
    navigate(`/shipping/${orderId}/${t}`);
  }

  const tabContent: Record<Tab, React.ReactNode> = {
    shipping: orderId ? <ShippingTab orderId={orderId} /> : null,
    tracking: orderId ? <TrackingTab orderId={orderId} /> : null,
    invoices: orderId ? <InvoicesTab orderId={orderId} /> : null,
    claims:   orderId ? <ClaimsTab   orderId={orderId} /> : null,
  };

  return (
    <div className={styles.layout}>
      <ShippingQueue selectedOrderId={orderId ?? null} onSelect={handleOrderSelect} />

      <div className={styles.main}>
        {!orderId ? (
          <div className={styles.empty}>
            <span>← Select an order to get started</span>
          </div>
        ) : (
          <>
            <div className={styles.tabs}>
              {VALID_TABS.map(t => (
                <button
                  key={t}
                  className={`${styles.tab} ${activeTab === t ? styles.tabActive : ''}`}
                  onClick={() => handleTabChange(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className={styles.tabContent}>
              {tabContent[activeTab]}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
