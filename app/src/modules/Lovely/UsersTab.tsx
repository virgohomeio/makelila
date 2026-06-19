import { useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import styles from './Lovely.module.css';

export function UsersTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      fullName(u).toLowerCase().includes(q) ||
      (u.email?.toLowerCase().includes(q) ?? false) ||
      (u.serial_number?.toLowerCase().includes(q) ?? false),
    );
  }, [users, search]);

  const verifiedCount = useMemo(() => users.filter(u => u.is_verified).length, [users]);

  return (
    <>
      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Total users</div>
          <div className={styles.kpiValue}>{users.length}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Verified</div>
          <div className={styles.kpiValue}>{verifiedCount}</div>
        </div>
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, serial…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'user' : 'users'}
        </div>
      </div>

      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Paired serial</th>
              <th>Onboarding</th>
              <th>Verified</th>
              <th>Last login</th>
              <th>Logins</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>Loading users…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>No users found.</td></tr>
            ) : (
              filtered.map(u => <UserRow key={u.id} u={u} />)
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function fullName(u: LovelyUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function UserRow({ u }: { u: LovelyUser }) {
  const name = fullName(u);
  return (
    <tr>
      <td><strong>{name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
      <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
      <td>
        <span className={u.is_verified ? styles.badgeOk : styles.badgeWarn}>
          {u.is_verified ? 'Verified' : 'Pending'}
        </span>
      </td>
      <td className={styles.mono}>{fmtDate(u.last_login_at)}</td>
      <td>{u.login_count ?? 0}</td>
      <td className={styles.mono}>{fmtDate(u.created_at)}</td>
    </tr>
  );
}
