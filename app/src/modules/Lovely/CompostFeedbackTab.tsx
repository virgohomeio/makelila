import { useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import {
  useLovelyCompostFeedback,
  COMPOST_RATINGS,
  ratingLabel,
  type ChamberAverages,
  type CompostFeedback,
} from '../../lib/lovelyCompostFeedback';
import styles from './Lovely.module.css';

export function CompostFeedbackTab() {
  const { feedback, loading, error, refetch } = useLovelyCompostFeedback();
  const { users } = useLovelyUsers();
  const [search, setSearch] = useState('');
  const [rating, setRating] = useState<string | null>(null);

  const usersById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of feedback) m.set(f.rating ?? '', (m.get(f.rating ?? '') ?? 0) + 1);
    return m;
  }, [feedback]);

  const healthy = counts.get('healthy') ?? 0;
  const healthyPct = feedback.length ? Math.round((healthy / feedback.length) * 100) : 0;
  const units = useMemo(
    () => new Set(feedback.map(f => f.serial_number).filter(Boolean)).size,
    [feedback],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return feedback.filter(f => {
      if (rating && f.rating !== rating) return false;
      if (!q) return true;
      const u = f.user_id ? usersById.get(f.user_id) : undefined;
      return (
        (f.serial_number?.toLowerCase().includes(q) ?? false) ||
        (f.note?.toLowerCase().includes(q) ?? false) ||
        (f.user_name?.toLowerCase().includes(q) ?? false) ||
        (u?.email.toLowerCase().includes(q) ?? false)
      );
    });
  }, [feedback, usersById, search, rating]);

  return (
    <>
      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Check-ins</div>
          <div className={styles.kpiValue}>{feedback.length}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Rated healthy</div>
          <div className={styles.kpiValue}>{healthyPct}%</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Problems reported</div>
          <div className={`${styles.kpiValue} ${feedback.length - healthy > 0 ? styles.kpiBad : ''}`}>
            {feedback.length - healthy}
          </div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Units</div>
          <div className={styles.kpiValue}>{units}</div>
        </div>
      </div>

      <p className={styles.sectionNote}>
        How customers rate their compost in the Lovely app. Humidity and temperature are the unit's
        7-day averages per chamber (left / right) at the moment they submitted.
      </p>

      <div className={styles.ratingChips}>
        <button
          className={`${styles.ratingChip} ${rating === null ? styles.ratingChipActive : ''}`}
          onClick={() => setRating(null)}
        >
          All <span className={styles.ratingChipCount}>{feedback.length}</span>
        </button>
        {COMPOST_RATINGS.map(r => (
          <button
            key={r.value}
            className={`${styles.ratingChip} ${rating === r.value ? styles.ratingChipActive : ''}`}
            onClick={() => setRating(rating === r.value ? null : r.value)}
          >
            {r.label} <span className={styles.ratingChipCount}>{counts.get(r.value) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, serial, note…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'check-in' : 'check-ins'}
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
              <th>Submitted</th>
              <th>Customer</th>
              <th>Serial</th>
              <th>Rating</th>
              <th>Note</th>
              <th>Humidity (L / R)</th>
              <th>Temp °C (L / R)</th>
            </tr>
          </thead>
          <tbody>
            {loading && feedback.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>Loading feedback…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>No feedback found.</td></tr>
            ) : (
              filtered.map(f => (
                <FeedbackRow key={f.id} f={f} user={f.user_id ? usersById.get(f.user_id) : undefined} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ratingBadge(rating: string | null): string {
  if (rating === 'healthy') return styles.badgeOk;
  if (rating === 'other' || !rating) return styles.badgeNeutral;
  if (rating === 'mold' || rating === 'stinky') return styles.badgeErr;
  return styles.badgeWarn;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function pair(l: ChamberAverages, r: ChamberAverages, key: 'humidity' | 'temperature', unit: string) {
  const fmt = (c: ChamberAverages) => (c[key] === null ? '—' : `${c[key]}${unit}`);
  if (l[key] === null && r[key] === null) return <span className={styles.muted}>No readings</span>;
  return `${fmt(l)} / ${fmt(r)}`;
}

function FeedbackRow({ f, user }: { f: CompostFeedback; user: LovelyUser | undefined }) {
  const name = f.user_name || [user?.first_name, user?.last_name].filter(Boolean).join(' ');
  return (
    <tr>
      <td className={styles.mono}>{fmtDate(f.created_at)}</td>
      <td>
        <div className={styles.ticketWho}>
          <strong>{name || user?.email || <span className={styles.muted}>—</span>}</strong>
          {name && user?.email && <span className={`${styles.mono} ${styles.muted}`}>{user.email}</span>}
        </div>
      </td>
      <td className={styles.mono}>{f.serial_number || <span className={styles.muted}>—</span>}</td>
      <td><span className={ratingBadge(f.rating)}>{ratingLabel(f.rating)}</span></td>
      <td className={styles.feedbackNote}>{f.note?.trim() || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>{pair(f.left, f.right, 'humidity', '%')}</td>
      <td className={styles.mono}>{pair(f.left, f.right, 'temperature', '')}</td>
    </tr>
  );
}
