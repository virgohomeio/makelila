import { useState } from 'react';
import { UnitsTab } from './UnitsTab';
import { PartsTab } from './PartsTab';
import styles from './Stock.module.css';

type Tab = 'units' | 'parts';

export default function Stock() {
  const [tab, setTab] = useState<Tab>('units');

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
      </div>
      {tab === 'units' ? <UnitsTab /> : <PartsTab />}
    </div>
  );
}
