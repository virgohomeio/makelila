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
// App-side aggregates come from the `lovely-activity` edge function (deployed on
// the Lovely project, operator-JWT gated). Machine-side presence comes from the
// telemetry tables via lib/dashboard.

// ── Thresholds ──────────────────────────────────────────────────────────────
// App buckets are business judgement; machine ones mirror what the rest of the
// stack already means by "connected": 10 min is the DIAGNOSE cutoff in
// dashboard.ts, and 2 h is what the Lovely PWA itself calls "disconnected"
// (beta-lovelyapp-host/app/api/dashboard/route.ts), so operators and customers
// read the same story.
export const APP_ACTIVE_DAYS = 7;
export const APP_COOLING_DAYS = 30;
export const MACHINE_ONLINE_MINUTES = 10;
export const MACHINE_INTERMITTENT_HOURS = 2;

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
  | 'notification' | 'batch' | 'ota' | 'feedback' | 'login' | 'profile';

export const SIGNAL_LABELS: Record<ActivitySignal, string> = {
  notification: 'Read notifications',
  batch: 'Started a batch',
  ota: 'Accepted an update',
  feedback: 'Sent feedback',
  login: 'Signed in',
  profile: 'Updated profile',
};

export type LastActivity = { at: string | null; signal: ActivitySignal | null };

export type AppBucket = 'active' | 'cooling' | 'dormant' | 'never';
export type MachineState = 'online' | 'intermittent' | 'offline' | 'never' | 'unpaired';

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
export function lastActivity(
  user: LovelyUser,
  activity: LovelyActivityRow | null | undefined,
): LastActivity {
  const candidates: Array<[ActivitySignal, string | null]> = [
    ['notification', activity?.last_notification_read_at ?? null],
    ['batch', activity?.last_batch_started_at ?? null],
    ['ota', activity?.ota_last_accepted_at ?? null],
    ['feedback', activity?.last_feedback_at ?? null],
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

export function machineState(
  serial: string | null,
  lastSeenAt: string | null,
  nowMs: number,
): MachineState {
  if (!serial) return 'unpaired';
  const age = msSince(lastSeenAt, nowMs);
  if (age === null) return 'never';
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
  const machineUp = machine === 'online' || machine === 'intermittent';
  if (appUp) return machineUp ? 'healthy' : 'unit_down';
  return machineUp ? 'silent_user' : 'at_risk';
}

// Joins the three sources into one row per user, ordered most-actionable first
// and then stalest-first within a status.
export function buildEntries(
  users: LovelyUser[],
  activity: LovelyActivityRow[],
  presence: Map<string, string | null>,
  nowMs: number,
): ActivityEntry[] {
  const byUser = new Map(activity.map(a => [a.user_id, a]));

  const entries: ActivityEntry[] = users.map(user => {
    const act = byUser.get(user.id) ?? null;
    const lastSeenAt = user.serial_number ? presence.get(user.serial_number) ?? null : null;
    const last = lastActivity(user, act);
    const app = appBucket(last.at, nowMs);
    const machine = machineState(user.serial_number, lastSeenAt, nowMs);
    return { user, activity: act, lastSeenAt, last, app, machine, status: activityStatus(user, app, machine) };
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
  const [presence, setPresence] = useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [presenceLoading, setPresenceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
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
      return;
    }
    setPresenceLoading(true);
    setTelemetryError(null);
    try {
      setPresence(await fetchTelemetryPresence(list));
    } catch (e) {
      // Telemetry is the softer half — degrade to app-only data rather than
      // blanking the roster.
      setTelemetryError((e as Error).message);
      setPresence(new Map());
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
    configured: isTelemetryConfigured,
    nowMs,
    refetch,
  };
}
