import { useState } from 'react';
import { JournalPanel } from './JournalPanel';
import styles from './Finance.module.css';

type Tab = 'journals' | 'projections';

const TABS: { key: Tab; label: string }[] = [
  { key: 'journals',    label: 'Journals' },
  { key: 'projections', label: 'Projections' },
];

export default function Finance() {
  const [tab, setTab] = useState<Tab>('journals');

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
        {tab === 'journals' && <JournalPanel />}
        {tab === 'projections' && (
          <div className={styles.empty}>Production &amp; Sales Projections — coming soon</div>
        )}
      </div>
    </div>
  );
}
