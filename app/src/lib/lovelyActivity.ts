import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { isTelemetryConfigured, TELEMETRY_URL, TELEMETRY_ANON_KEY } from './supabaseTelemetry';
import { fetchTelemetryPresence } from './dashboard';
import type { LovelyUser } from './lovely';

// Engagement view over the Lovely app. `users.last_login_at` alone badly
// undercounts real use — Lovely is a PWA, so a session survives for weeks and a
// daily user can look dormant. This module composites every timestamped thing
// the app writes (notification reads, OTA accepts, batches, feedback, profile
// writes) into a single "last activity", and crosses it with the machine's own
// telemetry heartbeat so operators can tell these apart:
//
//   app active  + machine up   → healthy
//   app active  + machine down → unit down, call today
//   app dormant + machine up   → silent user: composting fine, ignoring the app
//   app dormant + machine down → at risk
//
// "machine down" means telemetry answered and the unit was silent. A telemetry
// read that fails is a third thing — unknown — and never counts as down.
//
// App-side aggregates come from the `lovely-activity` edge function (deployed on
// the Lovely project, operator-JWT gated). Machine-side presence comes from the
// telemetry tables via lib/dashboard.

// ── Thresholds ──────────────────────────────────────────────────────────────
// App buckets are business judgement. Composting runs on a weekly-ish rhythm,
// so a 7-day window called a normal user "cooling" after one quiet week; 14
// days is one missed cycle and 45 is roughly a missed month.
export const APP_ACTIVE_DAYS = 14;
export const APP_COOLING_DAYS = 45;

// "Online" mirrors what the rest of the stack means by connected: 10 min is the
// DIAGNOSE cutoff in dashboard.ts. The far cutoff is deliberately NOT the PWA's
// 2 h "disconnected" banner — that answers "can I trust this reading right
// now", which is a different question from "should an operator call this
// customer". At 2 h every machine read offline overnight and the tab filled
// with false alarms, so a unit that reported at any point in the last day is
// intermittent, and only a full day of silence is offline.
export const MACHINE_ONLINE_MINUTES = 10;
export const MACHINE_INTERMITTENT_HOURS = 24;

// An approval writes users.is_verified, which bumps updated_at. Treating that
// as customer activity would make every freshly-approved user look active on
// the day an operator approved them, so a profile write this close to
// verified_at is attributed to the operator, not the customer.
const APPROVAL_BUMP_TOLERANCE_MS = 60_000;

// ── Types ───────────────────────────────────────────────────────────────────

export type PwaInstallState = 'installed' | 'accepted' | 'dismissed' | 'prompted' | 'none';

// One row per Lovely user, aggregated by the lovely-activity edge function.
export type LovelyActivityRow = {
  user_id: string;
  serial_number: string | null;
  last_notification_read_at: string | null;
  notifications_unread: number;
  ota_last_accepted_at: string | null;
  ota_accept_count: number;
  last_batch_started_at: string | null;
  last_batch_completed_at: string | null;
  active_batch_side: 'L' | 'R' | null;
  batch_count: number;
  last_feedback_at: string | null;
  feedback_count: number;
  push_device_count: number;
  pwa_install_state: PwaInstallState;
  pwa_platform: string | null;
  pwa_last_event_at: string | null;
  damage_report_count: number;
  last_damage_at: string | null;
};

export type ActivitySignal =
  | 'notification' | 'batch' | 'batch_completed' | 'ota' | 'feedback'
  | 'damage' | 'pwa' | 'login' | 'profile';

export const SIGNAL_LABELS: Record<ActivitySignal, string> = {
  notification: 'Read notifications',
  batch: 'Started a batch',
  batch_completed: 'Completed a batch',
  ota: 'Accepted an update',
  feedback: 'Sent feedback',
  damage: 'Reported damage',
  pwa: 'Installed the app',
  login: 'Signed in',
  profile: 'Updated profile',
};

export type LastActivity = { at: string | null; signal: ActivitySignal | null };

export type AppBucket = 'active' | 'cooling' | 'dormant' | 'never';
export type MachineState =
  | 'online' | 'intermittent' | 'offline' | 'never' | 'unpaired' | 'unknown';

// What the telemetry read managed to establish about one serial. Absence from
// the presence map is meaningful in its own right — see machineState.
export type PresenceEntry = {
  // Newest telemetry row found, or null if the search came up empty.
  at: string | null;
  // Whether the search covered all of history. False means we only looked
  // inside the recent window, so a null `at` proves silence across that window
  // and says nothing about older history.
  exact: boolean;
};

export type ActivityStatus =
  | 'unit_down' | 'at_risk' | 'never_used' | 'unverified'
  | 'unpaired' | 'silent_user' | 'healthy';

export type ActivityEntry = {
  user: LovelyUser;
  activity: LovelyActivityRow | null;
  lastSeenAt: string | null;
  last: LastActivity;
  app: AppBucket;
  machine: MachineState;
  status: ActivityStatus;
};

export const APP_BUCKET_LABELS: Record<AppBucket, string> = {
  active: `Active (≤${APP_ACTIVE_DAYS}d)`,
  cooling: `Cooling (${APP_ACTIVE_DAYS}–${APP_COOLING_DAYS}d)`,
  dormant: `Dormant (>${APP_COOLING_DAYS}d)`,
  never: 'Never used',
};

export const MACHINE_LABELS: Record<MachineState, string> = {
  online: 'Online',
  intermittent: 'Intermittent',
  offline: 'Offline',
  never: 'Never seen',
  unpaired: 'Not paired',
  unknown: 'No data',
};

export const STATUS_META: Record<
  ActivityStatus,
  { label: string; tone: 'bad' | 'warn' | 'info' | 'ok'; hint: string }
> = {
  unit_down: {
    label: 'Unit down',
    tone: 'bad',
    hint: 'Using the app, but the machine has stopped reporting — call today.',
  },
  at_risk: {
    label: 'At risk',
    tone: 'bad',
    hint: 'No app activity and no telemetry — churn candidate.',
  },
  never_used: {
    label: 'Never used',
    tone: 'warn',
    hint: 'Account exists and is paired, but nothing has ever happened in the app.',
  },
  unverified: {
    label: 'Pending approval',
    tone: 'warn',
    hint: 'Waiting on operator approval — they cannot use the app yet.',
  },
  unpaired: {
    label: 'Not paired',
    tone: 'info',
    hint: 'Approved but no serial linked, so there is no machine to watch.',
  },
  silent_user: {
    label: 'Silent user',
    tone: 'info',
    hint: 'Machine is running fine; they have stopped opening the app.',
  },
  healthy: {
    label: 'Healthy',
    tone: 'ok',
    hint: 'Using the app and the machine is reporting.',
  },
};

// Most actionable first, so the table's default order is the work queue.
const STATUS_ORDER: ActivityStatus[] = [
  'unit_down', 'at_risk', 'never_used', 'unverified', 'unpaired', 'silent_user', 'healthy',
];

// ── Pure logic ──────────────────────────────────────────────────────────────

function msSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : nowMs - t;
}

// users.updated_at, unless it looks like the operator's own approval write.
function profileSignalAt(user: LovelyUser): string | null {
  if (!user.updated_at) return null;
  if (user.verified_at) {
    const gap = Math.abs(Date.parse(user.updated_at) - Date.parse(user.verified_at));
    if (!Number.isNaN(gap) && gap < APPROVAL_BUMP_TOLERANCE_MS) return null;
  }
  return user.updated_at;
}

// The newest timestamp across every signal the app writes, plus which one it
// was — "4 days ago · read notifications" is actionable in a way a bare date
// is not. Order below is also the tie-break order (strongest signal wins).
//
// Every timestamped column the edge function returns is counted. Leaving any of
// them out silently ages a user: notification read_at is null for most of the
// roster, so a customer whose real last action was installing the PWA or filing
// a damage report used to fall back to a months-old login.
export function lastActivity(
  user: LovelyUser,
  activity: LovelyActivityRow | null | undefined,
): LastActivity {
  const candidates: Array<[ActivitySignal, string | null]> = [
    ['notification', activity?.last_notification_read_at ?? null],
    ['batch', activity?.last_batch_started_at ?? null],
    ['batch_completed', activity?.last_batch_completed_at ?? null],
    ['ota', activity?.ota_last_accepted_at ?? null],
    ['feedback', activity?.last_feedback_at ?? null],
    ['damage', activity?.last_damage_at ?? null],
    ['pwa', activity?.pwa_last_event_at ?? null],
    ['login', user.last_login_at],
    ['profile', profileSignalAt(user)],
  ];

  let best: LastActivity = { at: null, signal: null };
  let bestMs = -Infinity;
  for (const [signal, at] of candidates) {
    if (!at) continue;
    const t = Date.parse(at);
    if (Number.isNaN(t)) continue;
    if (t > bestMs) {
      bestMs = t;
      best = { at, signal };
    }
  }
  return best;
}

export function appBucket(at: string | null, nowMs: number): AppBucket {
  const age = msSince(at, nowMs);
  if (age === null) return 'never';
  if (age <= APP_ACTIVE_DAYS * 86_400_000) return 'active';
  if (age <= APP_COOLING_DAYS * 86_400_000) return 'cooling';
  return 'dormant';
}

// `presence` is undefined when the telemetry read never produced an answer for
// this serial — a failed or timed-out query. That is NOT the same as "the
// machine is silent", and conflating the two is what turned a single slow query
// into a roster-wide "everything is down". Unknown stays unknown.
export function machineState(
  serial: string | null,
  presence: PresenceEntry | undefined,
  nowMs: number,
): MachineState {
  if (!serial) return 'unpaired';
  if (!presence) return 'unknown';

  const age = msSince(presence.at, nowMs);
  if (age === null) {
    // Searched and found nothing. Across all of history that means never seen;
    // inside a bounded window it only proves the machine is quiet right now.
    return presence.exact ? 'never' : 'offline';
  }
  if (age <= MACHINE_ONLINE_MINUTES * 60_000) return 'online';
  if (age <= MACHINE_INTERMITTENT_HOURS * 3_600_000) return 'intermittent';
  return 'offline';
}

export function activityStatus(
  user: LovelyUser,
  app: AppBucket,
  machine: MachineState,
): ActivityStatus {
  if (!user.is_verified) return 'unverified';
  if (machine === 'unpaired' || !user.serial_number) return 'unpaired';
  if (app === 'never') return 'never_used';

  const appUp = app === 'active' || app === 'cooling';
  // 'unknown' counts as not-down. Every status on the down side of this matrix
  // is a call-the-customer alarm, and we will not raise one on the strength of
  // a telemetry read that failed. The Machine column shows "No data" and the
  // tab banners the failure, so the gap stays visible without crying wolf.
  const machineDown = machine === 'offline' || machine === 'never';
  if (appUp) return machineDown ? 'unit_down' : 'healthy';
  return machineDown ? 'at_risk' : 'silent_user';
}

// Joins the three sources into one row per user, ordered most-actionable first
// and then stalest-first within a status.
export function buildEntries(
  users: LovelyUser[],
  activity: LovelyActivityRow[],
  presence: Map<string, PresenceEntry>,
  nowMs: number,
): ActivityEntry[] {
  const byUser = new Map(activity.map(a => [a.user_id, a]));

  const entries: ActivityEntry[] = users.map(user => {
    const act = byUser.get(user.id) ?? null;
    // Deliberately not defaulted to null: a serial absent from the map means
    // telemetry never answered for it, which machineState reads as 'unknown'.
    const seen = user.serial_number ? presence.get(user.serial_number) : undefined;
    const last = lastActivity(user, act);
    const app = appBucket(last.at, nowMs);
    const machine = machineState(user.serial_number, seen, nowMs);
    return {
      user,
      activity: act,
      lastSeenAt: seen?.at ?? null,
      last,
      app,
      machine,
      status: activityStatus(user, app, machine),
    };
  });

  return entries.sort((a, b) => {
    const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (rank !== 0) return rank;
    // Stalest first: never-active sorts above merely-old.
    const at = a.last.at ? Date.parse(a.last.at) : -Infinity;
    const bt = b.last.at ? Date.parse(b.last.at) : -Infinity;
    return at - bt;
  });
}

export function statusCounts(entries: ActivityEntry[]): Record<ActivityStatus, number> {
  const counts = Object.fromEntries(
    STATUS_ORDER.map(s => [s, 0]),
  ) as Record<ActivityStatus, number>;
  for (const e of entries) counts[e.status] += 1;
  return counts;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLovelyActivity(users: LovelyUser[]) {
  const [activity, setActivity] = useState<LovelyActivityRow[]>([]);
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map());
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [presenceLoading, setPresenceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  // Partial failures: the read succeeded for most serials but not all. Those
  // rows show "No data" rather than dragging the whole roster down with them.
  const [telemetryWarnings, setTelemetryWarnings] = useState<string[]>([]);
  // Recomputed only when the roster actually changes, so relative-time
  // rendering doesn't re-bucket every row on every parent render.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const serials = useMemo(
    () => Array.from(new Set(users.map(u => u.serial_number).filter((s): s is string => !!s))),
    [users],
  );
  // Stable dependency: the array identity changes every parent render, the
  // joined key only changes when the set of serials does. The key is also what
  // the effect reads back from, so there's no ref to keep in sync.
  const serialKey = serials.join(',');

  const fetchActivity = useCallback(async () => {
    if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      // Direct fetch rather than functions.invoke so the function's JSON `error`
      // body stays readable on a non-2xx — same reason as lib/lovely.ts.
      const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-activity`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: TELEMETRY_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      });
      const bodyText = await res.text();
      if (!res.ok) {
        let detail = bodyText;
        try {
          const parsed = JSON.parse(bodyText) as { error?: string };
          if (parsed.error) detail = parsed.error;
        } catch { /* keep raw body */ }
        throw new Error(`Failed to load Lovely activity (${res.status}): ${detail}`);
      }
      const parsed = JSON.parse(bodyText) as { activity?: LovelyActivityRow[] };
      setActivity(parsed.activity ?? []);
      setNowMs(Date.now());
    } catch (e) {
      setError((e as Error).message);
      setActivity([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPresence = useCallback(async (list: string[]) => {
    if (!isTelemetryConfigured || list.length === 0) {
      setPresence(new Map());
      setTelemetryWarnings([]);
      return;
    }
    setPresenceLoading(true);
    setTelemetryError(null);
    try {
      const { presence: found, warnings } = await fetchTelemetryPresence(list);
      setPresence(found);
      setTelemetryWarnings(warnings);
    } catch (e) {
      // Telemetry is the softer half — degrade to app-only data rather than
      // blanking the roster. An empty map means every machine reads 'unknown',
      // which keeps the rows out of the down statuses entirely.
      setTelemetryError((e as Error).message);
      setPresence(new Map());
      setTelemetryWarnings([]);
    } finally {
      setPresenceLoading(false);
    }
  }, []);

  useEffect(() => { void fetchActivity(); }, [fetchActivity]);
  useEffect(() => {
    void fetchPresence(serialKey ? serialKey.split(',') : []);
  }, [fetchPresence, serialKey]);

  const refetch = useCallback(async () => {
    await Promise.all([
      fetchActivity(),
      fetchPresence(serialKey ? serialKey.split(',') : []),
    ]);
  }, [fetchActivity, fetchPresence, serialKey]);

  const entries = useMemo(
    () => buildEntries(users, activity, presence, nowMs),
    [users, activity, presence, nowMs],
  );

  return {
    entries,
    activity,
    loading: loading || presenceLoading,
    error,
    telemetryError,
    telemetryWarnings,
    configured: isTelemetryConfigured,
    nowMs,
    refetch,
  };
}
