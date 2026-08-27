import { Navigate, useSearchParams } from 'react-router-dom';
import { InboxTab } from './InboxTab';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import { FollowUpsTab } from './FollowUpsTab';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import { PageHeader, Tabs } from '../../components/ui';
import styles from './Service.module.css';

// Replacement used to be a tab here; it now lives at /fulfillment/replacements
// (the component itself still lives in this folder — see ReplacementTab.tsx).
type Tab = 'inbox' | 'onboarding' | 'support' | 'followups';

const TABS: { key: Tab; label: string }[] = [
  { key: 'onboarding',  label: 'Onboarding' },
  { key: 'followups',   label: 'Follow-Ups' },
  { key: 'support',     label: 'Support Tickets' },
  { key: 'inbox',       label: 'Inbox' },
];

// Mobile-specific tab metadata. Subtitle + icon make each card scannable
// without drilling in; lined up against `TABS` above by .key.
const MOBILE_TAB_META: Record<Tab, { subtitle: string; icon: string; iconBg: string }> = {
  inbox:       { subtitle: 'Untriaged Quo + email conversations',         icon: '📥', iconBg: '#fff3e0' },
  onboarding:  { subtitle: 'Customers in their first 30 days',            icon: '🚀', iconBg: '#e6f4ea' },
  support:     { subtitle: 'Open tickets needing follow-up or reply',     icon: '🎫', iconBg: '#fef1f0' },
  followups:   { subtitle: 'Calendar of onboarding calls + FU1/FU2',      icon: '🗓️', iconBg: '#e6f4ea' },
};

export default function Service() {
  const [searchParams, setSearchParams] = useSearchParams();
  const TAB_KEYS: Tab[] = ['inbox', 'onboarding', 'support', 'followups'];
  const paramTab = searchParams.get('tab');
  const tab: Tab = (TAB_KEYS as string[]).includes(paramTab ?? '') ? (paramTab as Tab) : 'onboarding';
  const setTab = (next: Tab) => setSearchParams(prev => { prev.set('tab', next); return prev; }, { replace: true });
  // Mobile uses null to mean "show the picker"; valid tab key shows content.
  const mobileActiveKey: Tab | null = (TAB_KEYS as string[]).includes(paramTab ?? '') ? (paramTab as Tab) : null;
  const setMobileTab = (next: Tab | null) =>
    setSearchParams(prev => { if (next) { prev.set('tab', next); } else { prev.delete('tab'); } return prev; }, { replace: true });
  const isMobile = useIsMobile();

  // Old bookmarks / links to the Replacement tab still work — it moved to
  // Fulfillment, so send them there instead of silently landing on Onboarding.
  if (paramTab === 'replacement') return <Navigate to="/fulfillment/replacements" replace />;

  if (isMobile) {
    const mobileTabs: MobileTab<Tab>[] = TABS.map(t => ({
      key: t.key,
      label: t.label,
      ...MOBILE_TAB_META[t.key],
      content:
        t.key === 'inbox'       ? <InboxTab /> :
        t.key === 'onboarding'  ? <OnboardingTab /> :
        t.key === 'support'     ? <SupportTab /> :
                                  <FollowUpsTab />,
    }));
    return (
      <div className={styles.layout}>
        <MobileTabbedModule tabs={mobileTabs} activeKey={mobileActiveKey} onChange={setMobileTab} />
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      {/* Service shipped with no page title while Sales had one, so moving
          between the two lost and regained a heading for no reason. Both now
          open the same way. */}
      <PageHeader
        title="Service"
        meta="Onboarding calls, follow-ups and support for shipped units."
      />
      <Tabs
        ariaLabel="Service sections"
        items={TABS.map(t => ({ key: t.key, label: t.label }))}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
      />
      <div className={styles.panel}>
        {tab === 'inbox'       && <InboxTab />}
        {tab === 'onboarding'  && <OnboardingTab />}
        {tab === 'support'     && <SupportTab />}
        {tab === 'followups'   && <FollowUpsTab />}
      </div>
    </div>
  );
}
