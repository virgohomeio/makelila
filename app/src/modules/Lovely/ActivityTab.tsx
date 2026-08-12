import { useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import {
  useLovelyActivity,
  statusCounts,
  STATUS_META,
  SIGNAL_LABELS,
  MACHINE_LABELS,
  APP_BUCKET_LABELS,
  APP_ACTIVE_DAYS,
  APP_COOLING_DAYS,
  MACHINE_ONLINE_MINUTES,
  MACHINE_INTERMITTENT_HOURS,
  type ActivityEntry,
  type ActivityStatus,
} from '../../lib/lovelyActivity';
import styles from './Lovely.module.css';

// Crosses app engagement with the machine's own telemetry heartbeat. Neither
// axis is worth much alone: login recency badly undercounts a PWA (sessions
// last weeks), and a live machine says nothing about whether anyone is opening
// the app. Together they separate "unit down, call today" from "silent user,
// leave alone" — which is the whole point of the tab.
export function ActivityTab() {
  const { users, loading: usersLoading, error: usersError, refetch: refetchUsers } = useLovelyUsers();
  const { entries, loading, error, telemetryError, nowMs, refetch } = useLovelyActivity(users);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ActivityStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const counts = useMemo(() => statusCounts(entries), [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e => {
      if (status && e.status !== status) return false;
      if (!q) return true;
      return (
        fullName(e.user).toLowerCase().includes(q) ||
        (e.user.email?.toLowerCase().includes(q) ?? false) ||
        (e.user.serial_number?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [entries, search, status]);

  const busy = loading || usersLoading;
  const toggleStatus = (s: ActivityStatus) => setStatus(cur => (cur === s ? null : s));

  return (
    <>
      <div className={styles.kpiRow}>
        <Kpi label="Lovely users" value={entries.length} />
        <Kpi label="Healthy" value={counts.healthy} />
        <Kpi label="Unit down" value={counts.unit_down} tone="bad" />
        <Kpi label="Silent users" value={counts.silent_user} tone="info" />
        <Kpi label="At risk" value={counts.at_risk} tone="bad" />
      </div>

      <div className={styles.matrix}>
        <div className={styles.matrixHead}>
          <div className={styles.matrixCorner}>
            App activity <span className={styles.muted}>×</span> machine
          </div>
          <div className={styles.matrixColLabel}>Machine reporting</div>
          <div className={styles.matrixColLabel}>Machine silent</div>
        </div>
        <div className={styles.matrixRow}>
          <div className={styles.matrixRowLabel}>Opening the app</div>
          <MatrixCell s="healthy" n={counts.healthy} active={status} onPick={toggleStatus} />
          <MatrixCell s="unit_down" n={counts.unit_down} active={status} onPick={toggleStatus} />
        </div>
        <div className={styles.matrixRow}>
          <div className={styles.matrixRowLabel}>Gone quiet</div>
          <MatrixCell s="silent_user" n={counts.silent_user} active={status} onPick={toggleStatus} />
          <MatrixCell s="at_risk" n={counts.at_risk} active={status} onPick={toggleStatus} />
        </div>
      </div>

      <div className={styles.chipRow}>
        {(['unverified', 'unpaired', 'never_used'] as ActivityStatus[]).map(s => (
          <button
            key={s}
            className={`${styles.chip} ${status === s ? styles.chipActive : ''}`}
            onClick={() => toggleStatus(s)}
            title={STATUS_META[s].hint}
          >
            {STATUS_META[s].label} <span className={styles.chipCount}>{counts[s]}</span>
          </button>
        ))}
        {status && (
          <button className={styles.chipClear} onClick={() => setStatus(null)}>
            Clear filter
          </button>
        )}
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, serial…"
          className={styles.searchInput}
        />
        <button
          className={styles.refreshBtn}
          disabled={busy}
          onClick={() => { void refetchUsers(); void refetch(); }}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
        <div className={styles.resultCount}>
          {filtered.length} of {entries.length}
        </div>
      </div>

      {(error || usersError) && (
        <div className={styles.errorBar}>
          Error: {error ?? usersError}{' '}
          <button onClick={() => { void refetchUsers(); void refetch(); }} className={styles.retryBtn}>
            Retry
          </button>
        </div>
      )}

      {telemetryError && (
        <div className={styles.calloutBar}>
          Machine telemetry unavailable — app-side data below is still accurate, but every
          unit reads as “Never seen”. ({telemetryError})
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr className={styles.groupRow}>
              <th colSpan={3}>Customer</th>
              <th colSpan={4} className={styles.groupDivide}>App</th>
              <th colSpan={2} className={styles.groupDivide}>Machine</th>
              <th colSpan={4} className={styles.groupDivide}>Product use</th>
            </tr>
            <tr>
              <th>Name</th>
              <th>Serial</th>
              <th>Status</th>
              <th className={styles.groupDivide}>Last activity</th>
              <th>Logins</th>
              <th>Notifications</th>
              <th>Install</th>
              <th className={styles.groupDivide}>State</th>
              <th>Last telemetry</th>
              <th className={styles.groupDivide}>Batches</th>
              <th>Updates</th>
              <th>Feedback</th>
              <th>Damage</th>
            </tr>
          </thead>
          <tbody>
            {busy && entries.length === 0 ? (
              <tr><td colSpan={13} className={styles.empty}>Loading activity…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={13} className={styles.empty}>No users match this view.</td></tr>
            ) : (
              filtered.map(e => (
                <Row
                  key={e.user.id}
                  e={e}
                  nowMs={nowMs}
                  expanded={expanded === e.user.id}
                  onToggle={() => setExpanded(cur => (cur === e.user.id ? null : e.user.id))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className={styles.sectionNote}>
        “Last activity” is the newest of: sign-in, profile write, notification read, update
        accepted, batch started, feedback sent — because Lovely is a PWA and a session can
        outlive a login by weeks, so sign-ins alone understate real use. App buckets:
        active ≤{APP_ACTIVE_DAYS}d, cooling ≤{APP_COOLING_DAYS}d, dormant beyond.
        Machine: online ≤{MACHINE_ONLINE_MINUTES}m, intermittent ≤{MACHINE_INTERMITTENT_HOURS}h,
        offline beyond — the same thresholds the customer’s own app uses. Passive
        viewing leaves no trace anywhere, so a user who only reads the dashboard still
        registers as quiet.
      </p>
    </>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'info' }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'bad' && value > 0 ? styles.kpiBad : ''}`}>
        {value}
      </div>
    </div>
  );
}

function MatrixCell({
  s, n, active, onPick,
}: {
  s: ActivityStatus;
  n: number;
  active: ActivityStatus | null;
  onPick: (s: ActivityStatus) => void;
}) {
  const meta = STATUS_META[s];
  return (
    <button
      className={`${styles.matrixCell} ${styles[`tone_${meta.tone}`]} ${active === s ? styles.matrixCellActive : ''}`}
      onClick={() => onPick(s)}
      title={meta.hint}
      aria-pressed={active === s}
    >
      <span className={styles.matrixCount}>{n}</span>
      <span className={styles.matrixLabel}>{meta.label}</span>
    </button>
  );
}

function Row({
  e, nowMs, expanded, onToggle,
}: {
  e: ActivityEntry;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { user, activity: a } = e;
  const meta = STATUS_META[e.status];
  const badge =
    meta.tone === 'bad' ? styles.badgeErr
    : meta.tone === 'warn' ? styles.badgeWarn
    : meta.tone === 'ok' ? styles.badgeOk
    : styles.badgeNeutral;

  return (
    <>
      <tr className={styles.clickRow} onClick={onToggle}>
        <td>
          <strong>{fullName(user) || <span className={styles.muted}>—</span>}</strong>
          <div className={styles.subLine}>{user.email}</div>
        </td>
        <td className={styles.mono}>
          {user.serial_number || <span className={styles.muted}>Not paired</span>}
        </td>
        <td>
          <span className={badge} title={meta.hint}>{meta.label}</span>
        </td>
        <td className={styles.groupDivide}>
          {e.last.at ? (
            <>
              {fmtAgo(e.last.at, nowMs)}
              <div className={styles.subLine}>
                {e.last.signal ? SIGNAL_LABELS[e.last.signal] : ''}
              </div>
            </>
          ) : (
            <span className={styles.muted}>Never</span>
          )}
        </td>
        <td>{user.login_count ?? 0}</td>
        <td>
          {a ? (
            <>
              {a.last_notification_read_at ? fmtAgo(a.last_notification_read_at, nowMs) : <span className={styles.muted}>Never read</span>}
              {a.notifications_unread > 0 && (
                <div className={styles.subLine}>{a.notifications_unread} unread</div>
              )}
            </>
          ) : <span className={styles.muted}>—</span>}
        </td>
        <td>
          {a ? (
            <>
              <span className={a.pwa_install_state === 'installed' ? styles.badgeOk : styles.badgeNeutral}>
                {INSTALL_LABELS[a.pwa_install_state]}
              </span>
              <div className={styles.subLine}>
                {a.push_device_count > 0
                  ? `${a.push_device_count} push device${a.push_device_count === 1 ? '' : 's'}`
                  : 'No push'}
              </div>
            </>
          ) : <span className={styles.muted}>—</span>}
        </td>
        <td className={styles.groupDivide}>
          <span className={machineBadge(e)}>{MACHINE_LABELS[e.machine]}</span>
        </td>
        <td className={styles.mono}>
          {e.lastSeenAt ? fmtAgo(e.lastSeenAt, nowMs) : <span className={styles.muted}>—</span>}
        </td>
        <td className={styles.groupDivide}>
          {a ? (
            <>
              {a.batch_count}
              {a.active_batch_side && (
                <div className={styles.subLine}>Running {a.active_batch_side}</div>
              )}
            </>
          ) : <span className={styles.muted}>—</span>}
        </td>
        <td>{a ? a.ota_accept_count : <span className={styles.muted}>—</span>}</td>
        <td>{a ? a.feedback_count : <span className={styles.muted}>—</span>}</td>
        <td>
          {a && a.damage_report_count > 0
            ? <span className={styles.badgeWarn}>{a.damage_report_count}</span>
            : <span className={styles.muted}>—</span>}
        </td>
      </tr>
      {expanded && <DetailRow e={e} nowMs={nowMs} />}
    </>
  );
}

// Every timestamp we hold for this user, newest first — the "what actually
// happened" view behind the summary row.
function DetailRow({ e, nowMs }: { e: ActivityEntry; nowMs: number }) {
  const { user, activity: a } = e;
  const events: Array<[string, string | null]> = [
    ['Joined', user.created_at],
    ['Approved', user.verified_at],
    ['Last sign-in', user.last_login_at],
    ['Profile updated', user.updated_at],
    ['Notifications read', a?.last_notification_read_at ?? null],
    ['Update accepted', a?.ota_last_accepted_at ?? null],
    ['Batch started', a?.last_batch_started_at ?? null],
    ['Batch completed', a?.last_batch_completed_at ?? null],
    ['Feedback sent', a?.last_feedback_at ?? null],
    ['Damage reported', a?.last_damage_at ?? null],
    ['Install prompt', a?.pwa_last_event_at ?? null],
    ['Machine last seen', e.lastSeenAt],
  ];
  const timeline = events
    .filter((x): x is [string, string] => !!x[1])
    .sort((x, y) => y[1].localeCompare(x[1]));

  return (
    <tr className={styles.diagDetailRow}>
      <td colSpan={13}>
        <div className={styles.detailGrid}>
          <div>
            <div className={styles.detailHead}>Timeline</div>
            {timeline.length === 0 ? (
              <div className={styles.muted}>Nothing recorded yet.</div>
            ) : (
              <ul className={styles.timeline}>
                {timeline.map(([label, at]) => (
                  <li key={label}>
                    <span className={styles.timelineLabel}>{label}</span>
                    <span className={styles.timelineAt}>
                      {fmtAgo(at, nowMs)} <span className={styles.muted}>· {fmtDate(at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className={styles.detailHead}>Read as</div>
            <div className={styles.detailNote}>{STATUS_META[e.status].hint}</div>
            <ul className={styles.detailFacts}>
              <li>App: {APP_BUCKET_LABELS[e.app]}</li>
              <li>Machine: {MACHINE_LABELS[e.machine]}</li>
              <li>Onboarding: {user.onboarding_step || '—'}</li>
              <li>Verified: {user.is_verified ? 'yes' : 'no'}</li>
              {a && <li>Install: {INSTALL_LABELS[a.pwa_install_state]}{a.pwa_platform ? ` · ${a.pwa_platform}` : ''}</li>}
            </ul>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const INSTALL_LABELS: Record<string, string> = {
  installed: 'Installed',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  prompted: 'Prompted',
  none: 'Browser only',
};

function machineBadge(e: ActivityEntry): string {
  switch (e.machine) {
    case 'online': return styles.badgeOk;
    case 'intermittent': return styles.badgeWarn;
    case 'offline': return styles.badgeErr;
    default: return styles.badgeNeutral;
  }
}

function fullName(u: LovelyUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}

function fmtAgo(s: string, nowMs: number): string {
  const ms = nowMs - Date.parse(s);
  if (Number.isNaN(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
