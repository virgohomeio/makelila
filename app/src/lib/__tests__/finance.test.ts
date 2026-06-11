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

import { repostJournal, isTokenExpiringSoon, projectStockout, computeRiskLevel } from '../finance';

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
