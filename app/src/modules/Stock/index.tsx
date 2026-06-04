import { useMemo, useState } from 'react';
import { UnitsTab } from './UnitsTab';
import { PartsTab } from './PartsTab';
import { OrphanUnitsTab } from './OrphanUnitsTab';
import { useUnits } from '../../lib/stock';
import styles from './Stock.module.css';

type Tab = 'units' | 'parts' | 'orphans';

export default function Stock() {
  const [tab, setTab] = useState<Tab>('units');
  const { units } = useUnits();
  const orphanCount = useMemo(
    () => units.filter(u => u.customer_name != null && u.customer_id == null && !u.is_team_test).length,
    [units],
  );

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
      </div>
      {tab === 'units' && <UnitsTab />}
      {tab === 'parts' && <PartsTab />}
      {tab === 'orphans' && <OrphanUnitsTab />}
    </div>
  );
}
