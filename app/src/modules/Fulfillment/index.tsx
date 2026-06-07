import { useNavigate, useParams } from 'react-router-dom';
import Queue from './queue';
import Shelf from './shelf';
import History from './history';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import styles from './Fulfillment.module.css';

type Tab = 'queue' | 'shelf' | 'history';

export default function Fulfillment() {
  const { tab } = useParams<{ tab?: Tab }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const active: Tab = tab === 'shelf' ? 'shelf'
                    : tab === 'history' ? 'history'
                    : 'queue';

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = [
      { key: 'queue',   label: 'Fulfillment Queue', subtitle: 'Active orders moving through assign → ship', icon: '📦', iconBg: '#fff3e0', content: <Queue /> },
      { key: 'shelf',   label: 'Inventory Shelf',   subtitle: 'Skid assignments + on-hand units',           icon: '🪜', iconBg: '#e3f0fb', content: <Shelf /> },
      { key: 'history', label: 'History',           subtitle: 'Fulfilled orders, searchable',               icon: '📜', iconBg: '#f5f1eb', content: <History /> },
    ];
    // Mobile uses URL-backed selection so deep links still work, and tapping
    // the brand "makelila" link returns to home as on every other module.
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
      </div>
      <div className={styles.tabPanel}>
        {active === 'queue'   ? <Queue /> :
         active === 'shelf'   ? <Shelf /> :
         <History />}
      </div>
    </div>
  );
}
