import { useNavigate, useParams } from 'react-router-dom';
import { ShippingTab } from './tabs/ShippingTab';
import { InvoicesTab } from './tabs/InvoicesTab';
import { ClaimsTab }   from './tabs/ClaimsTab';
import styles from './Shipping.module.css';

type Tab = 'shipping' | 'invoices' | 'claims';
const TABS: { id: Tab; label: string }[] = [
  { id: 'shipping', label: 'Shipping' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'claims',   label: 'Claims'   },
];

export default function Shipping() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const activeTab: Tab = TABS.some(t => t.id === tab) ? (tab as Tab) : 'shipping';

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
            onClick={() => navigate(`/shipping/${t.id}`)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.tabContent}>
        {activeTab === 'shipping' && <ShippingTab />}
        {activeTab === 'invoices' && <InvoicesTab />}
        {activeTab === 'claims'   && <ClaimsTab />}
      </div>
    </div>
  );
}
