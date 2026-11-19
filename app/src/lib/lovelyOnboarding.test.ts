import { describe, it, expect } from 'vitest';
import type { LovelyUser } from './lovely';
import type { ActivityEntry, MachineState } from './lovelyActivity';
import {
  buildSetupRows, daysOnStep, nowOnLabel, notOnlineAfterSetup, rowsForStep, stepKey,
  STUCK_AFTER_DAYS,
} from './lovelyOnboarding';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const user = (over: Partial<LovelyUser> = {}): LovelyUser => ({
  id: 'u1', email: 'a@x.com', first_name: 'Angela', last_name: 'Y',
  serial_number: 'LL01-00000000363', onboarding_step: 'tour_done', is_verified: true,
  verified_at: null, mailing_list: null, last_login_at: null, login_count: null,
  created_at: daysAgo(15), updated_at: null, phone_number: '+15551234567',
  onboarding_step_at: daysAgo(10), ...over,
});

const entry = (u: LovelyUser, machine: MachineState, lastSeenAt: string | null = null): ActivityEntry => ({
  user: u, activity: null, lastSeenAt, last: { at: null, signal: null },
  app: 'active', machine, status: 'healthy',
});

describe('daysOnStep', () => {
  it('counts whole days since the step changed', () => {
    expect(daysOnStep(user({ onboarding_step_at: daysAgo(4.6) }), NOW)).toBe(4);
    expect(daysOnStep(user({ onboarding_step_at: daysAgo(0.2) }), NOW)).toBe(0);
  });

  it('is unknown when the step time was never recorded', () => {
    expect(daysOnStep(user({ onboarding_step_at: null }), NOW)).toBeNull();
    expect(daysOnStep(user({ onboarding_step_at: undefined }), NOW)).toBeNull();
    expect(daysOnStep(user({ onboarding_step_at: 'not a date' }), NOW)).toBeNull();
  });
});

describe('nowOnLabel', () => {
  it('names the screen the user is looking at', () => {
    expect(nowOnLabel(user({ onboarding_step: 'hardware_done' }))).toBe('WiFi setup');
    expect(nowOnLabel(user({ onboarding_step: 'pairing' }))).toBe('Welcome');
    expect(nowOnLabel(user({ onboarding_step: null }))).toBe('Welcome');
  });

  it('puts unapproved accounts on Pending Approval after pairing', () => {
    expect(nowOnLabel(user({ onboarding_step: 'pairing_done', is_verified: false }))).toBe('Waiting for approval');
    expect(nowOnLabel(user({ onboarding_step: 'pairing_done', is_verified: true }))).toBe('Install the app');
  });

  it('treats a step it does not know as Welcome, like the app does', () => {
    expect(nowOnLabel(user({ onboarding_step: 'mystery_step' }))).toBe('Welcome');
  });
});

describe('notOnlineAfterSetup', () => {
  it("flags a finished setup whose machine was never seen (Angela's case)", () => {
    expect(notOnlineAfterSetup(entry(user(), 'never'), NOW)).toBe(true);
  });

  it('flags a machine silent all window when setup was recent', () => {
    expect(notOnlineAfterSetup(entry(user(), 'offline', null), NOW)).toBe(true);
  });

  it('leaves out a machine that reported and then stopped (that is Unit down)', () => {
    expect(notOnlineAfterSetup(entry(user(), 'offline', daysAgo(5)), NOW)).toBe(false);
  });

  it('leaves out an old setup whose machine has only gone quiet lately', () => {
    const old = user({ onboarding_step_at: daysAgo(90), created_at: daysAgo(100) });
    expect(notOnlineAfterSetup(entry(old, 'offline', null), NOW)).toBe(false);
    expect(notOnlineAfterSetup(entry(old, 'never'), NOW)).toBe(true);
  });

  it('waits out the grace period after setup', () => {
    const fresh = user({ onboarding_step_at: daysAgo(1) });
    expect(notOnlineAfterSetup(entry(fresh, 'never'), NOW)).toBe(false);
  });

  it('falls back to the signup date when the step time is unknown', () => {
    expect(notOnlineAfterSetup(entry(user({ onboarding_step_at: null, created_at: daysAgo(6) }), 'never'), NOW)).toBe(true);
    expect(notOnlineAfterSetup(entry(user({ onboarding_step_at: null, created_at: daysAgo(1) }), 'never'), NOW)).toBe(false);
  });

  it('ignores users still mid-setup, without a serial, or with unknown telemetry', () => {
    expect(notOnlineAfterSetup(entry(user({ onboarding_step: 'hardware_done' }), 'never'), NOW)).toBe(false);
    expect(notOnlineAfterSetup(entry(user({ serial_number: null }), 'unpaired'), NOW)).toBe(false);
    expect(notOnlineAfterSetup(entry(user(), 'unknown'), NOW)).toBe(false);
    expect(notOnlineAfterSetup(entry(user(), 'online', daysAgo(0)), NOW)).toBe(false);
  });

  it('counts pairing_done and install_done as finished setup', () => {
    expect(notOnlineAfterSetup(entry(user({ onboarding_step: 'pairing_done' }), 'never'), NOW)).toBe(true);
    expect(notOnlineAfterSetup(entry(user({ onboarding_step: 'install_done' }), 'never'), NOW)).toBe(true);
  });
});

describe('buildSetupRows', () => {
  it('marks a mid-setup user stuck after the threshold, never a finished one', () => {
    const stuck = user({ id: 's', onboarding_step: 'hardware_done', onboarding_step_at: daysAgo(STUCK_AFTER_DAYS) });
    const moving = user({ id: 'm', onboarding_step: 'hardware_done', onboarding_step_at: daysAgo(1) });
    const done = user({ id: 'd', onboarding_step: 'tour_done', onboarding_step_at: daysAgo(30) });
    const rows = buildSetupRows([stuck, moving, done], [], NOW);
    const byId = new Map(rows.map(r => [r.user.id, r]));
    expect(byId.get('s')!.stuck).toBe(true);
    expect(byId.get('m')!.stuck).toBe(false);
    expect(byId.get('d')!.stuck).toBe(false);
  });

  it('joins machine state from the activity entries, unknown when missing', () => {
    const u = user();
    const [withEntry] = buildSetupRows([u], [entry(u, 'never')], NOW);
    expect(withEntry.machine).toBe('never');
    expect(withEntry.notOnline).toBe(true);
    const [without] = buildSetupRows([u], [], NOW);
    expect(without.machine).toBe('unknown');
    expect(without.notOnline).toBe(false);
  });
});

describe('rowsForStep', () => {
  it('returns the step, longest-waiting first, unknown durations last', () => {
    const rows = buildSetupRows([
      user({ id: 'a', onboarding_step: 'hardware_done', onboarding_step_at: daysAgo(2) }),
      user({ id: 'b', onboarding_step: 'hardware_done', onboarding_step_at: null }),
      user({ id: 'c', onboarding_step: 'hardware_done', onboarding_step_at: daysAgo(9) }),
      user({ id: 'd', onboarding_step: 'quiz_done', onboarding_step_at: daysAgo(20) }),
    ], [], NOW);
    expect(rowsForStep(rows, 'hardware_done').map(r => r.user.id)).toEqual(['c', 'a', 'b']);
  });

  it('matches users with no step under the funnel key for them', () => {
    const rows = buildSetupRows([user({ id: 'n', onboarding_step: null })], [], NOW);
    expect(stepKey(rows[0].user)).toBe('(none)');
    expect(rowsForStep(rows, '(none)').map(r => r.user.id)).toEqual(['n']);
  });
});
