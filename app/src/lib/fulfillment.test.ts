import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, eqMock, fromMock, getUserMock, logActionMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  const fromMock = vi.fn(() => ({ update: updateMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const logActionMock = vi.fn(() => Promise.resolve());
  return { updateMock, eqMock, fromMock, getUserMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: getUserMock },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { confirmTestReport, toggleDockCheck, setStarterTracking } from './fulfillment';

describe('confirmTestReport', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
    logActionMock.mockReset();
    logActionMock.mockResolvedValue(undefined);
  });

  it('updates test_report_url + advances step 2→3 + logs fq_test_ok', async () => {
    await confirmTestReport('queue-1', 'https://drive.example/report.pdf');
    expect(fromMock).toHaveBeenCalledWith('fulfillment_queue');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      step: 3,
      test_report_url: 'https://drive.example/report.pdf',
      test_confirmed_by: 'user-1',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
    expect(logActionMock).toHaveBeenCalledWith('fq_test_ok', 'queue-1', expect.any(String));
  });

  it('treats empty URL as null', async () => {
    await confirmTestReport('queue-1');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      test_report_url: null,
      step: 3,
    }));
  });

  it('throws if unauthenticated', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await expect(confirmTestReport('queue-1')).rejects.toThrow(/not authenticated/i);
  });
});

describe('toggleDockCheck', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
  });

  it('flips the named boolean', async () => {
    await toggleDockCheck('queue-1', 'printed', true);
    expect(updateMock).toHaveBeenCalledWith({ dock_printed: true });
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
  });
});

describe('setStarterTracking', () => {
  beforeEach(() => {
    updateMock.mockReset();
    eqMock.mockReset();
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockResolvedValue({ data: null, error: null });
  });

  it('updates starter_tracking_num on the queue row', async () => {
    await setStarterTracking('queue-1', '1ZA99 starter');
    expect(updateMock).toHaveBeenCalledWith({ starter_tracking_num: '1ZA99 starter' });
    expect(eqMock).toHaveBeenCalledWith('id', 'queue-1');
  });
});
