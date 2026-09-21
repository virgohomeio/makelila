// Step 2 of fulfillment used to make the operator paste a test-report URL by
// hand even though Stock already had the report attached to that very serial.
// fetchUnitTestReport is the lookup that lets the step fill itself in, and
// tell the operator plainly when the unit has no report at all.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { maybeSingleMock, eqMock, fromMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  return { maybeSingleMock, eqMock, fromMock };
});

vi.mock('./supabase', () => ({
  supabase: { from: fromMock, storage: { from: () => ({ createSignedUrl: vi.fn() }) } },
}));
vi.mock('./activityLog', () => ({ logAction: vi.fn() }));

import { fetchUnitTestReport } from './testReports';

describe('fetchUnitTestReport', () => {
  beforeEach(() => {
    maybeSingleMock.mockReset();
    fromMock.mockClear();
    eqMock.mockClear();
  });

  it('returns the attached report for the serial', async () => {
    maybeSingleMock.mockResolvedValue({
      data: {
        test_report_path: 'LL01-00000000351/1784233188583-LL01-00000000351.md',
        test_report_name: 'LL01-00000000351.md',
        test_report_uploaded_at: '2026-07-16T20:19:48.842+00:00',
        electrical_check: 'pass',
        electrical_failed_tests: null,
      },
      error: null,
    });

    const report = await fetchUnitTestReport('LL01-00000000351');

    expect(fromMock).toHaveBeenCalledWith('units');
    expect(eqMock).toHaveBeenCalledWith('serial', 'LL01-00000000351');
    expect(report).toEqual({
      path: 'LL01-00000000351/1784233188583-LL01-00000000351.md',
      name: 'LL01-00000000351.md',
      uploadedAt: '2026-07-16T20:19:48.842+00:00',
      result: 'pass',
      failedTests: null,
    });
  });

  it('returns null when the unit exists but has no report attached', async () => {
    maybeSingleMock.mockResolvedValue({
      data: {
        test_report_path: null, test_report_name: null, test_report_uploaded_at: null,
        electrical_check: null, electrical_failed_tests: null,
      },
      error: null,
    });
    expect(await fetchUnitTestReport('LL01-00000000999')).toBeNull();
  });

  it('returns null when the serial is not a known unit', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect(await fetchUnitTestReport('NOPE')).toBeNull();
  });

  it('throws on a query error rather than silently reporting "no report"', async () => {
    // A failed lookup must not be dressed up as "no test report attached" —
    // that would read as a QC fact when it's actually a broken query.
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(fetchUnitTestReport('LL01-00000000351')).rejects.toThrow('permission denied');
  });
});
