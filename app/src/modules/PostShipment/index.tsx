import { useState } from 'react';
import { DashboardTab } from './DashboardTab';
import { ReturnsTab } from './ReturnsTab';
import { ReplacementsTab } from './ReplacementsTab';
import { DeliveryMapTab } from './DeliveryMapTab';
import { HistoryTab } from './HistoryTab';
import { RefundsTab } from './RefundsTab';
import { CancellationsTab } from './CancellationsTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
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

const MOBILE_TAB_META: Record<Tab, { subtitle: string; icon: string; iconBg: string }> = {
  dashboard:     { subtitle: 'KPIs, refund + return rates',           icon: '📊', iconBg: '#e3f0fb' },
  map:           { subtitle: 'Open shipments on a map',               icon: '🗺️', iconBg: '#e6f4ea' },
  history:       { subtitle: 'All shipped orders, searchable',        icon: '📜', iconBg: '#f5f1eb' },
  returns:       { subtitle: 'Inbound returns, inspection queue',     icon: '↩️', iconBg: '#fff3e0' },
  refunds:       { subtitle: 'Awaiting manager + finance approval',   icon: '💵', iconBg: '#fef1f0' },
  cancellations: { subtitle: 'Customer-initiated cancellations',      icon: '❌', iconBg: '#f5f1eb' },
  replacements:  { subtitle: 'Internal replacement orders + parts',   icon: '🔁', iconBg: '#fef1f0' },
};

export default function PostShipment() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const isMobile = useIsMobile();

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = TABS.map(t => ({
      key: t.key,
      label: t.label,
      ...MOBILE_TAB_META[t.key],
      content:
        t.key === 'dashboard'     ? <DashboardTab /> :
        t.key === 'map'           ? <DeliveryMapTab /> :
        t.key === 'history'       ? <HistoryTab /> :
        t.key === 'returns'       ? <ReturnsTab /> :
        t.key === 'refunds'       ? <RefundsTab /> :
        t.key === 'cancellations' ? <CancellationsTab /> :
                                    <ReplacementsTab />,
    }));
    return (
      <div className={styles.layout}>
        <MobileTabbedModule tabs={mobileTabs} />
      </div>
    );
  }

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
