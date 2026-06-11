import { useNavigate, useParams } from 'react-router-dom';
import Queue from './queue';
import Shelf from './shelf';
import History from './history';
import { DashboardTab } from '../PostShipment/DashboardTab';
import { ReturnsTab } from '../PostShipment/ReturnsTab';
import { RefundsTab } from '../PostShipment/RefundsTab';
import { ReplacementsTab } from '../PostShipment/ReplacementsTab';
import { CancellationsTab } from '../PostShipment/CancellationsTab';
import { DeliveryMapTab } from '../PostShipment/DeliveryMapTab';
import { FinanceTab } from '../PostShipment/FinanceTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import { useAuth } from '../../lib/auth';
import { canView } from '../../lib/permissions';
import styles from './Fulfillment.module.css';

type Tab =
  | 'queue' | 'shelf' | 'history'
  | 'returns' | 'refunds' | 'replacements' | 'cancellations'
  | 'dashboard' | 'map' | 'finance';

const VALID_TABS: Tab[] = [
  'queue', 'shelf', 'history',
  'returns', 'refunds', 'replacements', 'cancellations',
  'dashboard', 'map', 'finance',
];

export default function Fulfillment() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { role } = useAuth();

  const active: Tab = (VALID_TABS.includes(tab as Tab) ? tab : 'queue') as Tab;

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = [
      { key: 'queue',         label: 'Fulfillment Queue', subtitle: 'Active orders moving through assign → ship', icon: '📦', iconBg: '#fff3e0', content: <Queue /> },
      { key: 'shelf',         label: 'Inventory Shelf',   subtitle: 'Skid assignments + on-hand units',           icon: '🪜', iconBg: '#e3f0fb', content: <Shelf /> },
      { key: 'history',       label: 'History',           subtitle: 'Fulfilled orders, searchable',               icon: '📜', iconBg: '#f5f1eb', content: <History /> },
      { key: 'dashboard',     label: 'Dashboard',         subtitle: 'KPIs, refund + return rates',                icon: '📊', iconBg: '#e3f0fb', content: <DashboardTab /> },
      { key: 'map',           label: 'Delivery Map',      subtitle: 'Open shipments on a map',                    icon: '🗺️', iconBg: '#e6f4ea', content: <DeliveryMapTab /> },
      { key: 'returns',       label: 'Returns',           subtitle: 'Inbound returns, inspection queue',          icon: '↩️', iconBg: '#fff3e0', content: <ReturnsTab /> },
      { key: 'refunds',       label: 'Refunds',           subtitle: 'Awaiting manager + finance approval',        icon: '💵', iconBg: '#fef1f0', content: <RefundsTab /> },
      { key: 'replacements',  label: 'Replacements',      subtitle: 'Internal replacement orders + parts',        icon: '🔁', iconBg: '#fef1f0', content: <ReplacementsTab /> },
      { key: 'cancellations', label: 'Cancellations',     subtitle: 'Customer-initiated cancellations',           icon: '❌', iconBg: '#f5f1eb', content: <CancellationsTab /> },
      ...(canView(role, 'finance') ? [
        { key: 'finance' as Tab, label: 'Finance', subtitle: 'QBO journal summary (last 30d)', icon: '💰', iconBg: '#f0fff4', content: <FinanceTab /> },
      ] : []),
    ];
    return (
      <div className={styles.layout}>
        <MobileTabbedModule
          tabs={mobileTabs}
          activeKey={tab ? active : null}
          onChange={(k) => navigate(k ? `/fulfillment/${k}` : '/fulfillment')}
        />
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${active === 'queue' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/queue')}
        >Fulfillment Queue</button>
        <button
          className={`${styles.tab} ${active === 'shelf' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/shelf')}
        >Inventory Shelf</button>
        <button
          className={`${styles.tab} ${active === 'history' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/history')}
        >History</button>

        <span className={styles.tabDivider} />

        <button
          className={`${styles.tab} ${active === 'dashboard' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/dashboard')}
        >Dashboard</button>
        <button
          className={`${styles.tab} ${active === 'map' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/map')}
        >Delivery Map</button>
        <button
          className={`${styles.tab} ${active === 'returns' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/returns')}
        >Returns</button>
        <button
          className={`${styles.tab} ${active === 'refunds' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/refunds')}
        >Refunds</button>
        <button
          className={`${styles.tab} ${active === 'replacements' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/replacements')}
        >Replacements</button>
        <button
          className={`${styles.tab} ${active === 'cancellations' ? styles.active : ''}`}
          onClick={() => navigate('/fulfillment/cancellations')}
        >Cancellations</button>
        {canView(role, 'finance') && (
          <button
            className={`${styles.tab} ${active === 'finance' ? styles.active : ''}`}
            onClick={() => navigate('/fulfillment/finance')}
          >Finance</button>
        )}
      </div>
      <div className={styles.tabPanel}>
        {active === 'queue'         ? <Queue /> :
         active === 'shelf'         ? <Shelf /> :
         active === 'history'       ? <History /> :
         active === 'dashboard'     ? <DashboardTab /> :
         active === 'map'           ? <DeliveryMapTab /> :
         active === 'returns'       ? <ReturnsTab /> :
         active === 'refunds'       ? <RefundsTab /> :
         active === 'replacements'  ? <ReplacementsTab /> :
         active === 'cancellations' ? <CancellationsTab /> :
         active === 'finance'       ? <FinanceTab /> :
         <Queue />}
      </div>
    </div>
  );
}
