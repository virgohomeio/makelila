import { useMemo, useState } from 'react';
import { useLovelyUsers, onboardingFunnel, ONBOARDING_STEPS, type LovelyUser } from '../../lib/lovely';
import { useLovelyActivity, MACHINE_LABELS, type MachineState } from '../../lib/lovelyActivity';
import {
  buildSetupRows, rowsForStep, sortByWait, stepKey,
  STUCK_AFTER_DAYS, NOT_ONLINE_GRACE_DAYS, type SetupRow,
} from '../../lib/lovelyOnboarding';
import styles from './Lovely.module.css';

// Selection key for the "finished setup, machine not sending data" list; can't
// collide with a step code.
const NOT_ONLINE = '__not_online__';

export function OnboardingTab({ onGoToVerification }: { onGoToVerification: () => void }) {
  const { users, loading, error, refetch } = useLovelyUsers();
  const { entries, nowMs, telemetryError } = useLovelyActivity(users);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => onboardingFunnel(users), [users]);
  const pendingApproval = useMemo(() => users.filter(u => u.is_verified !== true).length, [users]);
  const setup = useMemo(() => buildSetupRows(users, entries, nowMs), [users, entries, nowMs]);
  const notOnline = useMemo(() => sortByWait(setup.filter(r => r.notOnline)), [setup]);
  const stuckByStep = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of setup) {
      if (r.stuck) counts.set(stepKey(r.user), (counts.get(stepKey(r.user)) ?? 0) + 1);
    }
    return counts;
  }, [setup]);
  const max = Math.max(1, ...rows.map(r => r.count));

  const listed = selected === NOT_ONLINE ? notOnline : selected ? rowsForStep(setup, selected) : [];
  const toggle = (key: string) => setSelected(cur => (cur === key ? null : key));

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

      {notOnline.length > 0 && (
        <div className={styles.alertBar}>
          {notOnline.length} customer{notOnline.length === 1 ? '' : 's'} finished setup {NOT_ONLINE_GRACE_DAYS}+ days
          ago, but {notOnline.length === 1 ? 'their machine isn’t' : 'their machines aren’t'} sending data ·{' '}
          <button className={styles.linkBtn} onClick={() => toggle(NOT_ONLINE)}>
            {selected === NOT_ONLINE ? 'hide' : 'show'}
          </button>
        </div>
      )}

      {telemetryError && (
        <div className={styles.sectionNote}>
          Machine status is unavailable ({telemetryError}), so machines that never came online can’t be flagged right now.
        </div>
      )}

      <div className={styles.funnel}>
        {rows.map(r => {
          const stuck = stuckByStep.get(r.code) ?? 0;
          return (
            <button
              key={r.code}
              type="button"
              className={`${styles.funnelRow} ${styles.funnelRowBtn} ${selected === r.code ? styles.funnelRowActive : ''}`}
              onClick={() => toggle(r.code)}
              aria-pressed={selected === r.code}
              disabled={r.count === 0}
            >
              <div className={styles.funnelLabel}>
                {r.label}
                {stuck > 0 && <div className={styles.funnelStuck}>{stuck} stuck {STUCK_AFTER_DAYS}+ days</div>}
              </div>
              <div className={styles.funnelBarTrack}>
                <div className={styles.funnelBar} style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
              </div>
              <div className={styles.funnelCount}>{r.count} <span className={styles.muted}>({r.pct}%)</span></div>
            </button>
          );
        })}
      </div>

      {selected && (
        <SetupList
          title={selected === NOT_ONLINE ? 'Finished setup, machine not sending data' : listTitle(selected)}
          rows={listed}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function listTitle(code: string): string {
  const step = ONBOARDING_STEPS.find(s => s.code === code);
  if (!step) return `Step: ${code}`;
  return code === 'tour_done' ? 'Finished setup' : `Finished “${step.label}”, now on: ${step.nowOn}`;
}

function SetupList({ title, rows, onClose }: { title: string; rows: SetupRow[]; onClose: () => void }) {
  return (
    <div className={styles.setupList}>
      <div className={styles.setupListHead}>
        <h3 className={styles.setupListTitle}>
          {title} <span className={styles.muted}>· {rows.length}</span>
        </h3>
        <button className={styles.linkBtn} onClick={onClose}>Close</button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th>Serial</th>
              <th>Now on</th>
              <th>On this step</th>
              <th>Machine</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>Nobody here.</td></tr>
            ) : (
              rows.map(r => <SetupRowView key={r.user.id} r={r} />)
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.sectionNote}>
        Time on a step is tracked from Oct 16, 2026. Customers who were already mid-setup before then show
        “Not tracked” until they reach their next step.
      </p>
    </div>
  );
}

function SetupRowView({ r }: { r: SetupRow }) {
  const name = fullName(r.user);
  return (
    <tr>
      <td>
        <strong>{name || <span className={styles.muted}>—</span>}</strong>
        <div className={styles.subLine}>
          <a className={styles.linkBtn} href={`mailto:${r.user.email}`}>{r.user.email}</a>
        </div>
      </td>
      <td className={styles.mono}>
        {r.user.phone_number
          ? <a className={styles.linkBtn} href={`tel:${r.user.phone_number}`}>{r.user.phone_number}</a>
          : <span className={styles.muted}>—</span>}
      </td>
      <td className={styles.mono}>{r.user.serial_number || <span className={styles.muted}>—</span>}</td>
      <td>{r.nowOn}</td>
      <td>
        {r.daysOnStep === null
          ? <span className={styles.muted}>Not tracked</span>
          : <>{r.daysOnStep} {r.daysOnStep === 1 ? 'day' : 'days'}</>}
        {r.stuck && <> <span className={styles.badgeWarn}>Stuck</span></>}
      </td>
      <td><span className={machineBadge(r.machine)}>{MACHINE_LABELS[r.machine]}</span></td>
      <td className={styles.mono}>{fmtDate(r.user.created_at)}</td>
    </tr>
  );
}

function machineBadge(m: MachineState): string {
  if (m === 'online') return styles.badgeOk;
  if (m === 'offline' || m === 'never') return styles.badgeErr;
  return styles.badgeNeutral;
}

function fullName(u: LovelyUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}
