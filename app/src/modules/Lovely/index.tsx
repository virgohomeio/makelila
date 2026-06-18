import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { isLeadership } from '../../lib/permissions';
import { useLovelyUsers } from '../../lib/lovely';
import { UsersTab } from './UsersTab';
import { VerificationTab } from './VerificationTab';
import { OnboardingTab } from './OnboardingTab';
import styles from './Lovely.module.css';

type Tab = 'users' | 'verification' | 'onboarding';

export default function Lovely() {
  const { role } = useAuth();
  const admin = isLeadership(role);
  const { configured, loading, refetch } = useLovelyUsers();
  const [tab, setTab] = useState<Tab>('users');

  if (!configured) {
    return (
      <div className={styles.layout}>
        <div className={styles.header}><h2 className={styles.title}>Lovely</h2></div>
        <div className={styles.notice}>
          <h3>Lovely telemetry not configured</h3>
          <p>
            Set <code>VITE_TELEMETRY_SUPABASE_URL</code> and{' '}
            <code>VITE_TELEMETRY_SUPABASE_ANON_KEY</code> in <code>.env</code> and reload.
          </p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'users', label: 'Users' },
    ...(admin
      ? ([
          { key: 'verification', label: 'Verification' },
          { key: 'onboarding', label: 'Onboarding' },
        ] as { key: Tab; label: string }[])
      : []),
  ];
  // Guard: if a non-admin somehow holds an admin tab in state, fall back to Users.
  const activeTab: Tab = tabs.some(t => t.key === tab) ? tab : 'users';

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Lovely</h2>
          <div className={styles.subTabs}>
            {tabs.map(t => (
              <button
                key={t.key}
                className={`${styles.subTab} ${activeTab === t.key ? styles.subTabActive : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => void refetch()} disabled={loading} className={styles.refreshBtn}>
            {loading ? 'Loading…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'verification' && admin && <VerificationTab />}
      {activeTab === 'onboarding' && admin && (
        <OnboardingTab onGoToVerification={() => setTab('verification')} />
      )}
    </div>
  );
}
