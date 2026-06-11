import { useState } from 'react';
import { JournalPanel } from './JournalPanel';
import { ProductionProjectionPanel } from './ProductionProjectionPanel';
import { SalesProjectionPanel } from './SalesProjectionPanel';
import styles from './Finance.module.css';

type Tab = 'journals' | 'projections';
type ProjectionsSubTab = 'production' | 'sales';

const TABS: { key: Tab; label: string }[] = [
  { key: 'journals',    label: 'Journals' },
  { key: 'projections', label: 'Projections' },
];

const PROJECTIONS_SUB_TABS: { key: ProjectionsSubTab; label: string }[] = [
  { key: 'production', label: 'Production' },
  { key: 'sales',      label: 'Sales' },
];

export default function Finance() {
  const [tab, setTab] = useState<Tab>('journals');
  const [projectionsSubTab, setProjectionsSubTab] = useState<ProjectionsSubTab>('production');

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

      {tab === 'projections' && (
        <div className={styles.subTabs}>
          {PROJECTIONS_SUB_TABS.map(s => (
            <button
              key={s.key}
              className={`${styles.subTab} ${projectionsSubTab === s.key ? styles.subTabActive : ''}`}
              onClick={() => setProjectionsSubTab(s.key)}
            >{s.label}</button>
          ))}
        </div>
      )}

      <div className={styles.panel}>
        {tab === 'journals' && <JournalPanel />}
        {tab === 'projections' && projectionsSubTab === 'production' && (
          <ProductionProjectionPanel />
        )}
        {tab === 'projections' && projectionsSubTab === 'sales' && (
          <SalesProjectionPanel />
        )}
      </div>
    </div>
  );
}
