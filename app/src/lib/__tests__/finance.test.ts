/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ------------------------------------------------------------------ mocks

const { invokesMock, logActionMock } = vi.hoisted(() => ({
  invokesMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../supabase', () => ({
  supabase: {
    functions: { invoke: invokesMock },
  },
}));

vi.mock('../activityLog', () => ({ logAction: logActionMock }));

import { repostJournal, isTokenExpiringSoon, projectStockout, computeRiskLevel, getProductFamily, projectRevenue, type SeasonalityConfig } from '../finance';

// ------------------------------------------------------------------ helpers

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

// ================================================================== repostJournal

describe('repostJournal', () => {
  beforeEach(() => {
    invokesMock.mockClear();
    logActionMock.mockClear();
  });

  it('success path: resolves and calls logAction with correct args', async () => {
    invokesMock.mockResolvedValueOnce({ data: {}, error: null });

    await expect(repostJournal('journal-123')).resolves.toBeUndefined();

    expect(invokesMock).toHaveBeenCalledWith('qbo-post-journal', { body: { id: 'journal-123' } });
    expect(logActionMock).toHaveBeenCalledWith(
      'repost_journal',
      'qbo_journal',
      'journal-123',
      expect.objectContaining({ entityType: 'qbo_daily_journals', entityId: 'journal-123' }),
    );
  });

  it('transport error: throws with the error message when supabase returns an error object', async () => {
    const transportErr = { message: 'Network error' };
    invokesMock.mockResolvedValueOnce({ data: null, error: transportErr });

    await expect(repostJournal('journal-456')).rejects.toMatchObject({ message: 'Network error' });
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('application error: throws with QBO error message when data.error is set', async () => {
    invokesMock.mockResolvedValueOnce({ data: { error: 'QBO token expired' }, error: null });

    await expect(repostJournal('journal-789')).rejects.toThrow('QBO token expired');
    expect(logActionMock).not.toHaveBeenCalled();
  });
});

// ================================================================== isTokenExpiringSoon

describe('isTokenExpiringSoon', () => {
  const NOW_MS = new Date('2026-06-11T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for a date 0 days out (already now)', () => {
    expect(isTokenExpiringSoon(new Date(NOW_MS).toISOString())).toBe(true);
  });

  it('returns true for a date 7 days out (well within 14-day window)', () => {
    expect(isTokenExpiringSoon(daysFromNow(7))).toBe(true);
  });

  it('returns true for a date exactly 14 days out (boundary is inclusive)', () => {
    // Exactly 14 days: expiresMs - nowMs === fourteenDaysMs → <= is true
    const exactly14 = new Date(NOW_MS + 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(isTokenExpiringSoon(exactly14)).toBe(true);
  });

  it('returns false for a date 15 days out (just outside the window)', () => {
    expect(isTokenExpiringSoon(daysFromNow(15))).toBe(false);
  });

  it('returns false for a date 30 days out', () => {
    expect(isTokenExpiringSoon(daysFromNow(30))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTokenExpiringSoon(null)).toBe(false);
  });
});

// ================================================================== projectStockout

describe('projectStockout', () => {
  it('returns null when velocity is 0', () => {
    expect(projectStockout({ ready: 10, velocity: 0, replacementQueue: 0, today: '2026-06-11' })).toBeNull();
  });

  it('returns today when demand already exceeds ready stock with no inbound', () => {
    expect(projectStockout({ ready: 5, velocity: 1, replacementQueue: 10, inboundUnits: 0, today: '2026-06-11' })).toBe('2026-06-11');
  });

  it('projects stockout date at correct future date', () => {
    // 10 ready, 2/week velocity, no replacement queue, no inbound → runs out in 5 weeks = ~35 days
    const result = projectStockout({ ready: 10, velocity: 2, replacementQueue: 0, today: '2026-06-11' });
    expect(result).not.toBeNull();
    const daysOut = (Date.parse(result!) - Date.parse('2026-06-11')) / (24 * 3600_000);
    expect(daysOut).toBeGreaterThan(30);
    expect(daysOut).toBeLessThan(40);
  });

  it('extends stockout when inbound batch arrives', () => {
    // Without inbound: 4 ready, 2/week → 2 weeks
    const withoutInbound = projectStockout({ ready: 4, velocity: 2, replacementQueue: 0, today: '2026-06-11' });
    // With inbound of 20 units arriving in 1 week: much later
    const withInbound = projectStockout({ ready: 4, velocity: 2, replacementQueue: 0, inboundUnits: 20, inboundArrivalDate: '2026-06-18', today: '2026-06-11' });
    expect(Date.parse(withInbound!)).toBeGreaterThan(Date.parse(withoutInbound!));
  });
});

// ================================================================== computeRiskLevel

describe('computeRiskLevel', () => {
  it('returns green for null stockout date', () => {
    expect(computeRiskLevel(null, '2026-06-11')).toBe('green');
  });
  it('returns red for stockout within 30 days', () => {
    expect(computeRiskLevel('2026-06-20', '2026-06-11')).toBe('red');
  });
  it('returns amber for stockout 30-90 days away', () => {
    expect(computeRiskLevel('2026-08-11', '2026-06-11')).toBe('amber');
  });
  it('returns green for stockout > 90 days away', () => {
    expect(computeRiskLevel('2027-01-01', '2026-06-11')).toBe('green');
  });
});

// ================================================================== getProductFamily

describe('getProductFamily', () => {
  it('identifies P100X before P100', () => {
    expect(getProductFamily([{ sku: 'LILA-P100X-WHITE', name: 'LILA P100X' }])).toBe('P100X');
  });
  it('identifies P100', () => {
    expect(getProductFamily([{ sku: 'P100-BLK' }])).toBe('P100');
  });
  it('identifies P50N', () => {
    expect(getProductFamily([{ name: 'P-50N Composter' }])).toBe('P50N');
  });
  it('identifies P150', () => {
    expect(getProductFamily([{ sku: 'P150' }])).toBe('P150');
  });
  it('returns other for unknown SKU', () => {
    expect(getProductFamily([{ sku: 'ACCESSORY-BAG' }])).toBe('other');
  });
  it('returns other for empty array', () => {
    expect(getProductFamily([])).toBe('other');
  });
});

// ================================================================== projectRevenue

describe('projectRevenue', () => {
  const flatSeasonality: SeasonalityConfig = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [String(i + 1), 1.0])
  );

  it('returns zero when velocity is 0', () => {
    const result = projectRevenue({ weeklyVelocity: 0, aov: 5000, seasonality: flatSeasonality, horizon: 30 });
    expect(result.projected).toBe(0);
    expect(result.lower).toBe(0);
    expect(result.upper).toBe(0);
  });

  it('30d projection: velocity=2/wk, aov=5000, flat seasonality = ~42857', () => {
    const result = projectRevenue({ weeklyVelocity: 2, aov: 5000, seasonality: flatSeasonality, horizon: 30, today: '2026-06-11' });
    // 2 * 5000 * (30/7) * 1.0 ≈ 42857
    expect(result.projected).toBeCloseTo(42857, -2);
  });

  it('confidence band is ±15%', () => {
    const result = projectRevenue({ weeklyVelocity: 2, aov: 5000, seasonality: flatSeasonality, horizon: 30, today: '2026-06-11' });
    expect(result.lower).toBeCloseTo(result.projected * 0.85, 0);
    expect(result.upper).toBeCloseTo(result.projected * 1.15, 0);
  });

  it('applies seasonality multiplier', () => {
    // December is 2x season (all months in a 30d horizon crossing Dec)
    const highSeason: SeasonalityConfig = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [String(i + 1), i === 11 ? 2.0 : 1.0])
    );
    const lowResult = projectRevenue({ weeklyVelocity: 2, aov: 5000, seasonality: flatSeasonality, horizon: 30, today: '2026-12-01' });
    const highResult = projectRevenue({ weeklyVelocity: 2, aov: 5000, seasonality: highSeason, horizon: 30, today: '2026-12-01' });
    expect(highResult.projected).toBeGreaterThan(lowResult.projected);
  });
});
