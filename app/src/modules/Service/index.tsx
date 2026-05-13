import { useState } from 'react';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import { RepairTab } from './RepairTab';
import styles from './Service.module.css';

type Tab = 'onboarding' | 'support' | 'repair';

const TABS: { key: Tab; label: string }[] = [
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'support',    label: 'Support Tickets' },
  { key: 'repair',     label: 'Repair' },
];

export default function Service() {
  const [tab, setTab] = useState<Tab>('support');

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
        {tab === 'onboarding' && <OnboardingTab />}
        {tab === 'support'    && <SupportTab />}
        {tab === 'repair'     && <RepairTab />}
      </div>
    </div>
  );
}
