import { describe, it, expect } from 'vitest';
import {
  daysIdle, dwellTier, dwellPercent, dwellLabel,
  DWELL_TICKS, FRESH_DAYS, STALE_DAYS,
} from '../dwell';

const NOW = Date.parse('2026-08-19T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('daysIdle', () => {
  it('counts whole days since the timestamp', () => {
    expect(daysIdle(daysAgo(0), NOW)).toBe(0);
    expect(daysIdle(daysAgo(1), NOW)).toBe(1);
    expect(daysIdle(daysAgo(68), NOW)).toBe(68);
  });

  it('floors a partial day rather than rounding up', () => {
    expect(daysIdle(new Date(NOW - 23 * 3_600_000).toISOString(), NOW)).toBe(0);
    expect(daysIdle(new Date(NOW - 25 * 3_600_000).toISOString(), NOW)).toBe(1);
  });

  // Synced rows can carry a timestamp slightly ahead of the client clock.
  it('clamps a future timestamp to 0 rather than going negative', () => {
    expect(daysIdle(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe(0);
  });

  it('treats a missing or unparseable timestamp as 0', () => {
    expect(daysIdle(null, NOW)).toBe(0);
    expect(daysIdle(undefined, NOW)).toBe(0);
    expect(daysIdle('not a date', NOW)).toBe(0);
  });
});

describe('dwellTier', () => {
  it('is fresh up to and including the fresh threshold', () => {
    expect(dwellTier(0)).toBe('fresh');
    expect(dwellTier(FRESH_DAYS)).toBe('fresh');
  });

  it('is mid between the thresholds, inclusive of the stale boundary', () => {
    expect(dwellTier(FRESH_DAYS + 1)).toBe('mid');
    expect(dwellTier(STALE_DAYS)).toBe('mid');
  });

  it('is stale past the stale threshold', () => {
    expect(dwellTier(STALE_DAYS + 1)).toBe('stale');
    expect(dwellTier(365)).toBe('stale');
  });
});

describe('dwellPercent', () => {
  it('pins the anchor points', () => {
    expect(dwellPercent(0)).toBe(0);
    expect(dwellPercent(FRESH_DAYS)).toBeCloseTo(25);
    expect(dwellPercent(STALE_DAYS)).toBeCloseTo(50);
    expect(dwellPercent(60)).toBeCloseTo(75);
    expect(dwellPercent(90)).toBe(100);
  });

  it('interpolates between anchors', () => {
    expect(dwellPercent(FRESH_DAYS / 2)).toBeCloseTo(12.5);
    // Midway between the 1-month and 2-month anchors.
    expect(dwellPercent(45)).toBeCloseTo(62.5);
  });

  it('never leaves 0–100, however old', () => {
    for (const d of [-5, 0, 1, 89, 90, 91, 5000]) {
      const p = dwellPercent(d);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it('increases monotonically', () => {
    let prev = -1;
    for (let d = 0; d <= 120; d++) {
      const p = dwellPercent(d);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('dwellLabel', () => {
  it('reads days inside the first month', () => {
    expect(dwellLabel(0)).toBe('today');
    expect(dwellLabel(1)).toBe('1d');
    expect(dwellLabel(STALE_DAYS)).toBe('30d');
  });

  it('switches to months past the stale threshold', () => {
    expect(dwellLabel(STALE_DAYS + 1)).toBe('1mo');
    expect(dwellLabel(68)).toBe('2mo');
    expect(dwellLabel(98)).toBe('3mo');
  });
});

describe('DWELL_TICKS', () => {
  it('spans the full rail', () => {
    expect(DWELL_TICKS[0].pct).toBe(0);
    expect(DWELL_TICKS[DWELL_TICKS.length - 1].pct).toBe(100);
  });

  // The ticks label the same scale the marks are placed on. If they drift, the
  // rail lies about where a row sits.
  it('agrees with dwellPercent at the labelled days', () => {
    expect(dwellPercent(0)).toBeCloseTo(DWELL_TICKS[0].pct);
    expect(dwellPercent(FRESH_DAYS)).toBeCloseTo(DWELL_TICKS[1].pct);
    expect(dwellPercent(STALE_DAYS)).toBeCloseTo(DWELL_TICKS[2].pct);
    expect(dwellPercent(60)).toBeCloseTo(DWELL_TICKS[3].pct);
    expect(dwellPercent(90)).toBeCloseTo(DWELL_TICKS[4].pct);
  });
});
