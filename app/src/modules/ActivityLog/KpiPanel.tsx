import { useMemo } from 'react';
import type { ActivityLogEntry } from '../../lib/activityLog';
import styles from './ActivityLog.module.css';

/** Right-side KPI panel for the Activity Log module (backlog #56 V1).
 *  Today's totals + 7-day per-user contribution. Aggregates the entries
 *  the Feed is already showing rather than re-querying — for the default
 *  feed of 100 most-recent entries this is enough signal for at-a-glance
 *  team activity. V2 should drop the row cap by reading aggregate rollups
 *  server-side instead. */
export function KpiPanel({ entries }: { entries: ActivityLogEntry[] }) {
  const stats = useMemo(() => compute(entries), [entries]);

  return (
    <aside className={styles.kpiPanel}>
      <h3 className={styles.kpiTitle}>Today</h3>
      <div className={styles.kpiTiles}>
        <KpiTile label="Total entries"  value={stats.todayCount} />
        <KpiTile label="Replacements"   value={stats.todayReplacement} />
        <KpiTile label="Orders shipped" value={stats.todayShipped} />
        <KpiTile label="Tickets closed" value={stats.todayClosed} />
      </div>

      <h3 className={styles.kpiTitle}>Team contribution (last 7 days)</h3>
      {stats.byUser.length === 0 ? (
        <div className={styles.kpiEmpty}>No team activity in the last 7 days.</div>
      ) : (
        <ul className={styles.kpiTeam}>
          {stats.byUser.map(u => (
            <li key={u.user_id} className={styles.kpiTeamRow}>
              <span className={styles.kpiAvatar}>{u.name.charAt(0).toUpperCase()}</span>
              <span className={styles.kpiTeamName}>{u.name}</span>
              <span className={styles.kpiTeamCount}>{u.count}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function KpiTile({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.kpiTile}>
      <div className={styles.kpiTileValue}>{value}</div>
      <div className={styles.kpiTileLabel}>{label}</div>
    </div>
  );
}

type Stats = {
  todayCount: number;
  todayReplacement: number;
  todayShipped: number;
  todayClosed: number;
  byUser: { user_id: string; name: string; count: number }[];
};

function compute(entries: ActivityLogEntry[]): Stats {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const weekAgoMs = now - 7 * 24 * 3600_000;

  let todayCount = 0, todayReplacement = 0, todayShipped = 0, todayClosed = 0;
  const userCounts = new Map<string, { name: string; count: number }>();

  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (t >= todayMs) {
      todayCount++;
      if (e.type === 'replacement_create') todayReplacement++;
      if (e.type === 'order_shipped') todayShipped++;
      if (e.type === 'ticket_auto_closed' || (e.type === 'ticket_status' && e.detail.includes('closed'))) todayClosed++;
    }
    if (t >= weekAgoMs) {
      const existing = userCounts.get(e.user_id);
      if (existing) existing.count++;
      else userCounts.set(e.user_id, { name: e.actor_name ?? '(unknown)', count: 1 });
    }
  }

  const byUser = Array.from(userCounts.entries())
    .map(([user_id, v]) => ({ user_id, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count);

  return { todayCount, todayReplacement, todayShipped, todayClosed, byUser };
}
