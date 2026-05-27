import { useState } from 'react';
import { DashboardTab } from './DashboardTab';
import { ReturnsTab } from './ReturnsTab';
import { ReplacementsTab } from './ReplacementsTab';
import { DeliveryMapTab } from './DeliveryMapTab';
import { HistoryTab } from './HistoryTab';
import { RefundsTab } from './RefundsTab';
import { CancellationsTab } from './CancellationsTab';
import styles from './PostShipment.module.css';

type Tab = 'dashboard' | 'map' | 'history' | 'returns' | 'refunds' | 'cancellations' | 'replacements';

const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard',     label: 'Dashboard' },
  { key: 'map',           label: 'Delivery Map' },
  { key: 'history',       label: 'Fulfillment History' },
  { key: 'returns',       label: 'Returns' },
  { key: 'refunds',       label: 'Refunds' },
  { key: 'cancellations', label: 'Cancellations' },
  { key: 'replacements',  label: 'Replacements' },
];

export default function PostShipment() {
  const [tab, setTab] = useState<Tab>('dashboard');

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.active : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>
      <div className={styles.panel}>
        {tab === 'dashboard'     && <DashboardTab />}
        {tab === 'map'           && <DeliveryMapTab />}
        {tab === 'history'       && <HistoryTab />}
        {tab === 'returns'       && <ReturnsTab />}
        {tab === 'refunds'       && <RefundsTab />}
        {tab === 'cancellations' && <CancellationsTab />}
        {tab === 'replacements'  && <ReplacementsTab />}
      </div>
    </div>
  );
}
