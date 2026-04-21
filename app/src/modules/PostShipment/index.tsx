import { useState } from 'react';
import { ReturnsTab } from './ReturnsTab';
import { ReplacementsTab } from './ReplacementsTab';
import styles from './PostShipment.module.css';

type Tab = 'returns' | 'replacements';

export default function PostShipment() {
  const [tab, setTab] = useState<Tab>('returns');

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'returns' ? styles.active : ''}`}
          onClick={() => setTab('returns')}
        >Returns</button>
        <button
          className={`${styles.tab} ${tab === 'replacements' ? styles.active : ''}`}
          onClick={() => setTab('replacements')}
        >Replacements</button>
      </div>
      <div className={styles.panel}>
        {tab === 'returns' ? <ReturnsTab /> : <ReplacementsTab />}
      </div>
    </div>
  );
}
