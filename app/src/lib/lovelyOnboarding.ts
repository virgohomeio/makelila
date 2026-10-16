import { ONBOARDING_STEPS, type LovelyUser } from './lovely';
import type { ActivityEntry, MachineState } from './lovelyActivity';

// "Who is stuck in setup" for the Lovely › Onboarding tab: each funnel step
// opens a list of the customers on it, how long they've been there and how to
// reach them, and finished setups whose machine never started reporting are
// flagged on their own. Pure logic; the tab feeds it useLovelyUsers and
// useLovelyActivity.

// Days on one mid-setup screen before a customer counts as stuck.
export const STUCK_AFTER_DAYS = 3;
// Days after finishing setup before a silent machine is flagged. A machine
// normally reports within minutes, so this only absorbs the customer not
// having plugged it in yet.
export const NOT_ONLINE_GRACE_DAYS = 3;
// A machine silent for the whole telemetry window, whose older history
// couldn't be checked, is only flagged when setup was this recent. Past that
// it's more likely a unit that ran and died, which the Activity tab owns.
export const RECENT_SETUP_DAYS = 30;

const DAY_MS = 86_400_000;
const SETUP_DONE_STEPS = new Set(['pairing_done', 'install_done', 'tour_done']);
const NOW_ON = new Map(ONBOARDING_STEPS.map(s => [s.code, s.nowOn]));

export type SetupRow = {
  user: LovelyUser;
  /** Whole days on the current step; null when the step time wasn't recorded. */
  daysOnStep: number | null;
  nowOn: string;
  stuck: boolean;
  machine: MachineState;
  notOnline: boolean;
};

// The key onboardingFunnel counts a user under.
export function stepKey(user: LovelyUser): string {
  return user.onboarding_step || '(none)';
}

export function daysOnStep(user: LovelyUser, nowMs: number): number | null {
  if (!user.onboarding_step_at) return null;
  const at = Date.parse(user.onboarding_step_at);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / DAY_MS));
}

// The screen in front of the user. The app shows Welcome for a missing or
// unrecognised step, so this does too.
export function nowOnLabel(user: LovelyUser): string {
  if (user.onboarding_step === 'pairing_done' && !user.is_verified) return 'Waiting for approval';
  return NOW_ON.get(user.onboarding_step ?? '') ?? 'Welcome';
}

// Finished setup at least NOT_ONLINE_GRACE_DAYS ago, but the machine isn't
// sending data. 'unknown' (telemetry read failed) is never flagged, same rule
// as the Activity tab.
export function notOnlineAfterSetup(entry: ActivityEntry, nowMs: number): boolean {
  const u = entry.user;
  if (!u.serial_number || !SETUP_DONE_STEPS.has(u.onboarding_step ?? '')) return false;
  // Before step times were tracked, signup is the best lower bound we have.
  const since = Date.parse(u.onboarding_step_at ?? u.created_at ?? '');
  if (Number.isNaN(since)) return false;
  const age = nowMs - since;
  if (age < NOT_ONLINE_GRACE_DAYS * DAY_MS) return false;

  if (entry.machine === 'never') return true;
  return entry.machine === 'offline' && entry.lastSeenAt === null && age <= RECENT_SETUP_DAYS * DAY_MS;
}

export function buildSetupRows(users: LovelyUser[], entries: ActivityEntry[], nowMs: number): SetupRow[] {
  const byUser = new Map(entries.map(e => [e.user.id, e]));
  return users.map(user => {
    const days = daysOnStep(user, nowMs);
    const entry = byUser.get(user.id);
    return {
      user,
      daysOnStep: days,
      nowOn: nowOnLabel(user),
      stuck: user.onboarding_step !== 'tour_done' && days !== null && days >= STUCK_AFTER_DAYS,
      machine: entry?.machine ?? 'unknown',
      notOnline: entry ? notOnlineAfterSetup(entry, nowMs) : false,
    };
  });
}

// Longest-waiting first; unknown durations last, oldest signup first among them.
export function sortByWait(rows: SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) => {
    if (a.daysOnStep !== b.daysOnStep) {
      if (a.daysOnStep === null) return 1;
      if (b.daysOnStep === null) return -1;
      return b.daysOnStep - a.daysOnStep;
    }
    return (a.user.created_at ?? '').localeCompare(b.user.created_at ?? '');
  });
}

export function rowsForStep(rows: SetupRow[], code: string): SetupRow[] {
  return sortByWait(rows.filter(r => stepKey(r.user) === code));
}
