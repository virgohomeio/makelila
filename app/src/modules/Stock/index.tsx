import { useMemo, useState } from 'react';
import { UnitsTab } from './UnitsTab';
import { PartsTab } from './PartsTab';
import { OrphanUnitsTab } from './OrphanUnitsTab';
import Build from '../Build';
import { useUnits } from '../../lib/stock';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import styles from './Stock.module.css';

type Tab = 'units' | 'parts' | 'orphans' | 'manufacturing';

export default function Stock() {
  const [tab, setTab] = useState<Tab>('units');
  const { units } = useUnits();
  const isMobile = useIsMobile();
  const orphanCount = useMemo(
    () => units.filter(u => u.customer_name != null && u.customer_id == null && !u.is_team_test).length,
    [units],
  );

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = [
      { key: 'units',   label: 'LILA Units',          subtitle: 'All units · serial tracking · status', icon: '🧊', iconBg: '#e3f0fb', content: <UnitsTab /> },
      { key: 'parts',   label: 'Parts & Consumables', subtitle: 'Spare parts inventory',                icon: '🔧', iconBg: '#e6f4ea', content: <PartsTab /> },
      {
        key: 'orphans', label: 'Unlinked',
        subtitle: 'Units with customer name but no canonical link',
        icon: '🔗', iconBg: '#fff3e0',
        count: orphanCount > 0 ? orphanCount : undefined,
        countTone: orphanCount > 0 ? 'warn' : 'default',
        content: <OrphanUnitsTab />,
      },
      { key: 'manufacturing', label: 'Manufacturing', subtitle: 'Build pipeline · QC dashboard · station passes', icon: '🏗️', iconBg: '#e6f4ea', content: <Build /> },
    ];
    return (
      <div className={styles.stockShell}>
        <MobileTabbedModule tabs={mobileTabs} />
      </div>
    );
  }

  return (
    <div className={styles.stockShell}>
      <div className={styles.stockTabs}>
        <button
          className={`${styles.stockTab} ${tab === 'units' ? styles.active : ''}`}
          onClick={() => setTab('units')}
        >LILA Units</button>
        <button
          className={`${styles.stockTab} ${tab === 'parts' ? styles.active : ''}`}
          onClick={() => setTab('parts')}
        >Parts &amp; Consumables</button>
        <button
          className={`${styles.stockTab} ${tab === 'orphans' ? styles.active : ''}`}
          onClick={() => setTab('orphans')}
          title="Units with customer_name but no canonical customer link"
        >
          Unlinked{orphanCount > 0 && <span className={styles.orphanBadge}>{orphanCount}</span>}
        </button>
        <button
          className={`${styles.stockTab} ${tab === 'manufacturing' ? styles.active : ''}`}
          onClick={() => setTab('manufacturing')}
        >Manufacturing</button>
      </div>
      {tab === 'units' && <UnitsTab />}
      {tab === 'parts' && <PartsTab />}
      {tab === 'orphans' && <OrphanUnitsTab />}
      {tab === 'manufacturing' && <Build />}
    </div>
  );
}
