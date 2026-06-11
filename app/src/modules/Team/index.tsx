import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  modules: { label: string; path: string }[];
};

const MEMBERS: Member[] = [
  {
    name: 'Pedrum',
    email: 'pedrum@virgohome.io',
    modules: [
      { label: 'Marketing', path: '/marketing' },
      { label: 'Sales',     path: '/order-review' },
    ],
  },
  {
    name: 'Raymond',
    email: 'raymond@virgohome.io',
    modules: [
      { label: 'Fulfillment', path: '/fulfillment' },
    ],
  },
  {
    name: 'Junaid',
    email: 'junaid@virgohome.io',
    modules: [
      { label: 'Stock', path: '/stock' },
    ],
  },
  {
    name: 'Reina',
    email: 'reina@virgohome.io',
    modules: [
      { label: 'Service', path: '/service' },
    ],
  },
  {
    name: 'Hua Yi',
    email: 'huayi@virgohome.io',
    modules: [
      { label: 'Customers', path: '/customers' },
    ],
  },
  {
    name: 'George',
    email: 'george@virgohome.io',
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
          <div className={styles.teamGrid}>
            {MEMBERS.map(m => (
              <div key={m.email} className={styles.memberCard}>
                <div className={styles.avatar}>{initials(m.name)}</div>
                <div className={styles.memberInfo}>
                  <div className={styles.memberName}>{m.name}</div>
                  <div className={styles.memberEmail}>{m.email}</div>
                  <div className={styles.moduleList}>
                    {m.modules.map(mod => (
                      <Link
                        key={mod.path}
                        to={mod.path}
                        className={styles.moduleBadge}
                      >
                        {mod.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'activity-log' && <ActivityLog />}
      </div>
    </div>
  );
}
