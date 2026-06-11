import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useActivityLog } from '../../lib/activityLog';
import { Feed } from '../ActivityLog/Feed';
import ActivityLog from '../ActivityLog';
import styles from './Team.module.css';

type Tab = 'team' | 'activity-log';

const TABS: { key: Tab; label: string }[] = [
  { key: 'team',         label: 'Team' },
  { key: 'activity-log', label: 'Activity Log' },
];

type Member = {
  name: string;
  email: string;
  responsibility: string;
  jobDescription: string;
  modules: { label: string; path: string }[];
};

const MEMBERS: Member[] = [
  {
    name: 'Pedrum',
    email: 'pedrum@virgohome.io',
    responsibility: 'Marketing & Sales',
    jobDescription: 'Manages all marketing channels, ad spend, and pre-sale customer interactions. Owns the Marketing module and Sales pipeline from lead to confirmed order.',
    modules: [
      { label: 'Marketing', path: '/marketing' },
      { label: 'Sales',     path: '/order-review' },
    ],
  },
  {
    name: 'Raymond',
    email: 'raymond@virgohome.io',
    responsibility: 'Operations & Fulfillment',
    jobDescription: 'Manages order fulfillment from queue through shipment. Oversees inventory shelf, skid management, dock operations, and shipping label generation.',
    modules: [
      { label: 'Fulfillment', path: '/fulfillment' },
    ],
  },
  {
    name: 'Junaid',
    email: 'junaid@virgohome.io',
    responsibility: 'Customer Service & Stock',
    jobDescription: 'Handles customer service tickets and manages stock. Owns unit serial tracking, parts inventory, and batch receipt workflows.',
    modules: [
      { label: 'Stock', path: '/stock' },
    ],
  },
  {
    name: 'Reina',
    email: 'reina@virgohome.io',
    responsibility: 'Customer Onboarding & Support',
    jobDescription: 'Leads customer onboarding for new LILA owners, handles inbound support tickets, and conducts 7-day and 30-day follow-up check-ins.',
    modules: [
      { label: 'Service', path: '/service' },
    ],
  },
  {
    name: 'Hua Yi',
    email: 'huayi@virgohome.io',
    responsibility: 'Technology & Finance',
    jobDescription: 'Owns app infrastructure, the Finance module, mobile experience, and cross-cutting engineering. Manages system integrations and data pipeline reliability.',
    modules: [
      { label: 'Customers', path: '/customers' },
    ],
  },
  {
    name: 'George',
    email: 'george@virgohome.io',
    responsibility: 'Finance & Compliance',
    jobDescription: 'Reviews and approves refunds, manages QuickBooks Online integration, and oversees financial reporting, reconciliation, and billing compliance.',
    modules: [
      { label: 'Finance', path: '/finance' },
    ],
  },
];

function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function Team() {
  const [tab, setTab] = useState<Tab>('team');
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const { entries, loading: logLoading } = useActivityLog(300);

  const memberEntries = useMemo(
    () => selectedMember
      ? entries.filter(e => e.actor_name === selectedMember.name)
      : [],
    [entries, selectedMember],
  );

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
        {tab === 'team' && (
          <div className={styles.teamContent}>
            <div className={styles.teamGrid}>
              {MEMBERS.map(m => (
                <div
                  key={m.email}
                  className={`${styles.memberCard} ${selectedMember?.email === m.email ? styles.memberCardSelected : ''}`}
                  onClick={() => setSelectedMember(prev => prev?.email === m.email ? null : m)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedMember(prev => prev?.email === m.email ? null : m)}
                >
                  <div className={styles.avatar}>{initials(m.name)}</div>
                  <div className={styles.memberInfo}>
                    <div className={styles.memberName}>{m.name}</div>
                    <div className={styles.memberEmail}>{m.email}</div>
                    <div className={styles.memberResp}>{m.responsibility}</div>
                    <div className={styles.moduleList}>
                      {m.modules.map(mod => (
                        <Link
                          key={mod.path}
                          to={mod.path}
                          className={styles.moduleBadge}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {mod.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {selectedMember && (
              <div className={styles.detailPanel}>
                <div className={styles.detailHeader}>
                  <div className={styles.detailAvatar}>{initials(selectedMember.name)}</div>
                  <div className={styles.detailHeaderInfo}>
                    <div className={styles.detailName}>{selectedMember.name}</div>
                    <div className={styles.detailEmail}>{selectedMember.email}</div>
                  </div>
                  <button className={styles.detailClose} onClick={() => setSelectedMember(null)}>×</button>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Responsibility</div>
                  <div className={styles.detailValue}>{selectedMember.responsibility}</div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Job Description</div>
                  <div className={styles.detailValue}>{selectedMember.jobDescription}</div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailLabel}>Activity Log</div>
                  {logLoading
                    ? <div className={styles.detailEmpty}>Loading…</div>
                    : <Feed entries={memberEntries} />
                  }
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'activity-log' && <ActivityLog />}
      </div>
    </div>
  );
}
