import { useState } from 'react';
import { useLovelyUsers } from '../../lib/lovely';
import { UsersTab } from './UsersTab';
import { ActivityTab } from './ActivityTab';
import { VerificationTab } from './VerificationTab';
import { OnboardingTab } from './OnboardingTab';
import { FirmwareTab } from './FirmwareTab';
import styles from './Lovely.module.css';

type Tab = 'users' | 'activity' | 'verification' | 'onboarding' | 'firmware';

// Every tab is open to all signed-in operators. The edge functions behind them
// gate on the @virgohome.io org domain, which is the real perimeter here.
const TABS: { key: Tab; label: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'activity', label: 'Activity' },
  { key: 'verification', label: 'Verification' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'firmware', label: 'Firmware' },
];

export default function Lovely() {
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

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <h2 className={styles.title}>Lovely</h2>
        <div className={styles.headerActions}>
          <button onClick={() => void refetch()} disabled={loading} className={styles.refreshBtn}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className={styles.subTabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.subTab} ${tab === t.key ? styles.subTabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'verification' && <VerificationTab />}
      {tab === 'onboarding' && (
        <OnboardingTab onGoToVerification={() => setTab('verification')} />
      )}
      {tab === 'firmware' && <FirmwareTab />}
    </div>
  );
}
