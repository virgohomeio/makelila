import { useMemo, useState } from 'react';
import { useLovelyUsers, approveLovelyUser, type LovelyUser } from '../../lib/lovely';
import { logAction } from '../../lib/activityLog';
import styles from './Lovely.module.css';

export function VerificationTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      users
        .filter(u => u.is_verified !== true)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    [users],
  );

  const approve = async (u: LovelyUser) => {
    setBusyId(u.id);
    setActionErr(null);
    try {
      await approveLovelyUser(u.id);
      await logAction('lovely_user_verified', u.email ?? u.id, `Approved Lovely app user ${u.email ?? u.id}`);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className={styles.sectionNote}>
        Approving sets the user to verified in the Lovely app — they’re let through the
        pending-approval gate on their next visit.
      </div>
      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}
      {actionErr && <div className={styles.errorBar}>{actionErr}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Paired serial</th>
              <th>Step</th>
              <th>Signed up</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>Loading…</td></tr>
            ) : pending.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>No users pending verification. 🎉</td></tr>
            ) : (
              pending.map(u => (
                <tr key={u.id}>
                  <td><strong>{[u.first_name, u.last_name].filter(Boolean).join(' ') || <span className={styles.muted}>—</span>}</strong></td>
                  <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
                  <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                  <td>
                    <button
                      className={styles.approveBtn}
                      disabled={busyId === u.id}
                      onClick={() => void approve(u)}
                    >
                      {busyId === u.id ? 'Approving…' : 'Approve'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
