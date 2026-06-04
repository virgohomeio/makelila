import { useState } from 'react';
import { InboxTab } from './InboxTab';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import ReplacementTab from './ReplacementTab';
import styles from './Service.module.css';

type Tab = 'inbox' | 'onboarding' | 'support' | 'replacement';

const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox',       label: 'Inbox' },
  { key: 'onboarding',  label: 'Onboarding' },
  { key: 'support',     label: 'Support Tickets' },
  { key: 'replacement', label: 'Replacement' },
];

export default function Service() {
  const [tab, setTab] = useState<Tab>('inbox');

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
        {tab === 'inbox'       && <InboxTab />}
        {tab === 'onboarding'  && <OnboardingTab />}
        {tab === 'support'     && <SupportTab />}
        {tab === 'replacement' && <ReplacementTab />}
      </div>
    </div>
  );
}
