import { logAction, useActivityLog } from '../../lib/activityLog';
import { useAuth } from '../../lib/auth';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
import { Feed } from './Feed';
import { KpiPanel } from './KpiPanel';
import styles from './ActivityLog.module.css';

type Tab = 'history' | 'kpi';

export default function ActivityLog() {
  const { entries, loading } = useActivityLog(200);
  const { profile } = useAuth();
  const isMobile = useIsMobile();

  const ping = () => void logAction(
    'infra_ping',
    'Infra ping',
    `Ping from ${profile?.display_name ?? 'unknown'}`,
  );

  if (isMobile) {
    const tabs: MobileTab<Tab>[] = [
      {
        key: 'history',
        label: 'Activity History',
        subtitle: 'Latest 200 audit-trail entries',
        icon: '📜',
        iconBg: '#f5f1eb',
        content: loading
          ? <div className={styles.empty}>Loading…</div>
          : <Feed entries={entries} />,
      },
      {
        key: 'kpi',
        label: 'KPI View',
        subtitle: 'Activity by user · daily / weekly counts',
        icon: '📊',
        iconBg: '#e3f0fb',
        content: <KpiPanel />,
      },
    ];
    return (
      <div className={styles.layout}>
        <header className={styles.header}>
          <h1 className={styles.title}>Activity Log</h1>
          <button className={styles.pingBtn} onClick={ping}>Fire test ping</button>
        </header>
        <MobileTabbedModule tabs={tabs} />
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <h1 className={styles.title}>Activity Log</h1>
        <button className={styles.pingBtn} onClick={ping}>Fire test ping</button>
      </header>

      <div className={styles.body}>
        <section className={styles.feedColumn}>
          {loading ? (
            <div className={styles.empty}>Loading…</div>
          ) : (
            <Feed entries={entries} />
          )}
        </section>
        <KpiPanel />
      </div>
    </div>
  );
}
