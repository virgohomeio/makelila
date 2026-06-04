import { sessionize, type ActivityLogEntry } from '../../lib/activityLog';
import styles from './ActivityLog.module.css';

export function Feed({ entries }: { entries: ActivityLogEntry[] }) {
  const sessions = sessionize(entries);
  if (entries.length === 0) {
    return <div className={styles.empty}>No activity yet.</div>;
  }
  return (
    <div className={styles.feed}>
      <div className={styles.feedHeader}>Team activity</div>
      {sessions.map((s, i) => (
        <div key={`${s.user_id}-${s.started_at}-${i}`} className={styles.session}>
          <div className={styles.sessionHeader}>
            <span className={styles.actorAvatar}>{initial(s.actor_name, s.user_id)}</span>
            <div className={styles.sessionMeta}>
              <div className={styles.actorName}>{s.actor_name ?? '(unknown)'}</div>
              <div className={styles.sessionTime}>
                {fmtRange(s.started_at, s.ended_at)} · {s.entries.length} {s.entries.length === 1 ? 'entry' : 'entries'}
              </div>
            </div>
          </div>
          <ul className={styles.sessionEntries}>
            {s.entries.map(e => (
              <li key={e.id} className={styles.entry}>
                <span className={styles.entryTime}>{fmtTime(e.ts)}</span>
                <span className={styles.entryType}>{e.type}</span>
                <span className={styles.entryEntity}>{e.entity}</span>
                {e.detail && <span className={styles.entryDetail}>{e.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function initial(name: string | null, fallback: string): string {
  const src = name && name.trim() ? name : fallback;
  return src.charAt(0).toUpperCase();
}

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  if (s.getTime() === e.getTime()) {
    return s.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (sameDay) {
    return `${s.toLocaleString('en-US', { month: 'short', day: 'numeric' })} · ${fmtTime(end)}–${fmtTime(start)}`;
  }
  return `${fmtTime(end)}, ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${fmtTime(start)}, ${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
