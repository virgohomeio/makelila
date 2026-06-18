import { useMemo } from 'react';
import { useLovelyUsers, onboardingFunnel } from '../../lib/lovely';
import styles from './Lovely.module.css';

export function OnboardingTab({ onGoToVerification }: { onGoToVerification: () => void }) {
  const { users, loading, error, refetch } = useLovelyUsers();
  const rows = useMemo(() => onboardingFunnel(users), [users]);
  const pendingApproval = useMemo(() => users.filter(u => u.is_verified !== true).length, [users]);
  const max = Math.max(1, ...rows.map(r => r.count));

  if (loading && users.length === 0) return <div className={styles.empty}>Loading…</div>;

  return (
    <>
      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}

      {pendingApproval > 0 && (
        <div className={styles.calloutBar}>
          {pendingApproval} user{pendingApproval === 1 ? '' : 's'} pending approval ·{' '}
          <button className={styles.linkBtn} onClick={onGoToVerification}>review →</button>
        </div>
      )}

      <div className={styles.funnel}>
        {rows.map(r => (
          <div key={r.code} className={styles.funnelRow}>
            <div className={styles.funnelLabel}>{r.label}</div>
            <div className={styles.funnelBarTrack}>
              <div className={styles.funnelBar} style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
            </div>
            <div className={styles.funnelCount}>{r.count} <span className={styles.muted}>({r.pct}%)</span></div>
          </div>
        ))}
      </div>
    </>
  );
}
