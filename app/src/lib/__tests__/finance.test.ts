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

import { repostJournal, isTokenExpiringSoon } from '../finance';

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
