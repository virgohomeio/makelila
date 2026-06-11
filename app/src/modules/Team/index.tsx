import { useState } from 'react';
import ActivityLog from '../ActivityLog';
import styles from './Team.module.css';

type Tab = 'activity-log';

const TABS: { key: Tab; label: string }[] = [
  { key: 'activity-log', label: 'Activity Log' },
];

export default function Team() {
  const [tab, setTab] = useState<Tab>('activity-log');

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
        {tab === 'activity-log' && <ActivityLog />}
      </div>
    </div>
  );
}
