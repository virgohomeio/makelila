import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shouldAutoCreate, autoTicketDescription } from '../service';

// ============================================================ shouldAutoCreate

// Hold thresholds (must match service.ts):
//   DIAGNOSE:    6h
//   NO_BME_DATA: 24h
//   DRY_SOIL:    48h
//   SOAKED_SOIL: 48h
//   OPEN_LID:    4h
//   NOT_MIXING:  DISABLED (always false)
//   OK:          never
//   NEW_FOOD:    never

describe('shouldAutoCreate', () => {
  // Use a fixed "now" so tests are deterministic.
  const NOW_MS = new Date('2026-06-10T12:00:00Z').getTime();

  function msAgo(ms: number): Date {
    return new Date(NOW_MS - ms);
  }

  function hoursAgo(h: number): Date {
    return msAgo(h * 3_600_000);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- DIAGNOSE (threshold: 6h) ----

  it('DIAGNOSE held 7h → true', () => {
    expect(shouldAutoCreate('DIAGNOSE', hoursAgo(7))).toBe(true);
  });

  it('DIAGNOSE held 5h → false', () => {
    expect(shouldAutoCreate('DIAGNOSE', hoursAgo(5))).toBe(false);
  });

  it('DIAGNOSE held exactly 6h → true (threshold is inclusive)', () => {
    expect(shouldAutoCreate('DIAGNOSE', hoursAgo(6))).toBe(true);
  });

  // ---- NOT_MIXING (always disabled) ----

  it('NOT_MIXING held 100h → false (permanently disabled, backlog #70)', () => {
    expect(shouldAutoCreate('NOT_MIXING', hoursAgo(100))).toBe(false);
  });

  it('NOT_MIXING held 0h → false', () => {
    expect(shouldAutoCreate('NOT_MIXING', hoursAgo(0))).toBe(false);
  });

  // ---- OK / NEW_FOOD (healthy states, never trigger) ----

  it('OK held 100h → false', () => {
    expect(shouldAutoCreate('OK', hoursAgo(100))).toBe(false);
  });

  it('NEW_FOOD held 100h → false', () => {
    expect(shouldAutoCreate('NEW_FOOD', hoursAgo(100))).toBe(false);
  });

  // ---- OPEN_LID (threshold: 4h) ----

  it('OPEN_LID held 5h → true', () => {
    expect(shouldAutoCreate('OPEN_LID', hoursAgo(5))).toBe(true);
  });

  it('OPEN_LID held 3h → false', () => {
    expect(shouldAutoCreate('OPEN_LID', hoursAgo(3))).toBe(false);
  });

  // ---- DRY_SOIL (threshold: 48h) ----

  it('DRY_SOIL held 47h → false', () => {
    expect(shouldAutoCreate('DRY_SOIL', hoursAgo(47))).toBe(false);
  });

  it('DRY_SOIL held 49h → true', () => {
    expect(shouldAutoCreate('DRY_SOIL', hoursAgo(49))).toBe(true);
  });

  // ---- SOAKED_SOIL (threshold: 48h) ----

  it('SOAKED_SOIL held 47h → false', () => {
    expect(shouldAutoCreate('SOAKED_SOIL', hoursAgo(47))).toBe(false);
  });

  it('SOAKED_SOIL held 49h → true', () => {
    expect(shouldAutoCreate('SOAKED_SOIL', hoursAgo(49))).toBe(true);
  });

  // ---- NO_BME_DATA (threshold: 24h) ----

  it('NO_BME_DATA held 23h → false', () => {
    expect(shouldAutoCreate('NO_BME_DATA', hoursAgo(23))).toBe(false);
  });

  it('NO_BME_DATA held 25h → true', () => {
    expect(shouldAutoCreate('NO_BME_DATA', hoursAgo(25))).toBe(true);
  });

  // ---- Unknown states ----

  it('UNKNOWN state held any duration → false', () => {
    expect(shouldAutoCreate('UNKNOWN', hoursAgo(999))).toBe(false);
  });
});

// ============================================================ autoTicketDescription

describe('autoTicketDescription', () => {
  const NOW_MS = new Date('2026-06-10T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a string mentioning the state', () => {
    const heldSince = new Date(NOW_MS - 7 * 3_600_000);
    const desc = autoTicketDescription('DIAGNOSE', heldSince);
    expect(desc).toContain('DIAGNOSE');
  });

  it('returns a string mentioning the hold duration in hours', () => {
    const heldSince = new Date(NOW_MS - 7 * 3_600_000);
    const desc = autoTicketDescription('DIAGNOSE', heldSince);
    expect(desc).toContain('7h');
  });

  it('accepts a string timestamp', () => {
    const heldSince = new Date(NOW_MS - 5 * 3_600_000).toISOString();
    const desc = autoTicketDescription('OPEN_LID', heldSince);
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(10);
  });

  it('does not throw for NOT_MIXING (even though auto-create is disabled)', () => {
    // The description helper is pure and does not enforce the disable rule —
    // that's shouldAutoCreate's job.
    const heldSince = new Date(NOW_MS - 100 * 3_600_000);
    expect(() => autoTicketDescription('NOT_MIXING', heldSince)).not.toThrow();
  });
});
