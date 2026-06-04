import { logAction, useActivityLog } from '../../lib/activityLog';
import { useAuth } from '../../lib/auth';
import { Feed } from './Feed';
import { KpiPanel } from './KpiPanel';
import styles from './ActivityLog.module.css';

export default function ActivityLog() {
  const { entries, loading } = useActivityLog(200);
  const { profile } = useAuth();

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <h1 className={styles.title}>Activity Log</h1>
        <button
          className={styles.pingBtn}
          onClick={() => void logAction(
            'infra_ping',
            'Infra ping',
            `Ping from ${profile?.display_name ?? 'unknown'}`,
          )}
        >Fire test ping</button>
      </header>

      <div className={styles.body}>
        <section className={styles.feedColumn}>
          {loading ? (
            <div className={styles.empty}>Loading…</div>
          ) : (
            <Feed entries={entries} />
          )}
        </section>
        <KpiPanel entries={entries} />
      </div>
    </div>
  );
}
