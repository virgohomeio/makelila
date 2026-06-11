import { useState } from 'react';
import { InboxTab } from './InboxTab';
import { OnboardingTab } from './OnboardingTab';
import { FollowUpsTab } from './FollowUpsTab';
import { SupportTab } from './SupportTab';
import ReplacementTab from './ReplacementTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import styles from './Service.module.css';

type Tab = 'inbox' | 'onboarding' | 'followups' | 'support' | 'replacement';

const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox',       label: 'Inbox' },
  { key: 'onboarding',  label: 'Onboarding' },
  { key: 'followups',   label: 'Follow-ups' },
  { key: 'support',     label: 'Support Tickets' },
  { key: 'replacement', label: 'Replacement' },
];

const MOBILE_TAB_META: Record<Tab, { subtitle: string; icon: string; iconBg: string }> = {
  inbox:       { subtitle: 'Untriaged Quo + email conversations',         icon: '📥', iconBg: '#fff3e0' },
  onboarding:  { subtitle: 'Customers in their first 30 days',            icon: '🚀', iconBg: '#e6f4ea' },
  followups:   { subtitle: 'FU1 (7-day) + FU2 (30-day) check-in calendar', icon: '📅', iconBg: '#f0f4ff' },
  support:     { subtitle: 'Open tickets needing follow-up or reply',     icon: '🎫', iconBg: '#fef1f0' },
  replacement: { subtitle: 'Warranty replacements + parts queue',         icon: '🔁', iconBg: '#fef1f0' },
};

export default function Service() {
  const [tab, setTab] = useState<Tab>('inbox');
  const isMobile = useIsMobile();

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = TABS.map(t => ({
      key: t.key,
      label: t.label,
      ...MOBILE_TAB_META[t.key],
      content:
        t.key === 'inbox'       ? <InboxTab /> :
        t.key === 'onboarding'  ? <OnboardingTab /> :
        t.key === 'followups'   ? <FollowUpsTab /> :
        t.key === 'support'     ? <SupportTab /> :
                                  <ReplacementTab />,
    }));
    return (
      <div className={styles.layout}>
        <MobileTabbedModule tabs={mobileTabs} />
      </div>
    );
  }

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
        {tab === 'followups'   && <FollowUpsTab />}
        {tab === 'support'     && <SupportTab />}
        {tab === 'replacement' && <ReplacementTab />}
      </div>
    </div>
  );
}
