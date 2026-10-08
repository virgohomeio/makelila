// uploadTestReports: the MAC from each report is written to the unit, and a
// MAC that already belongs to a different serial — in the database or earlier
// in the same drop — is reported as a clash. Pairing is never blocked by a
// clash; it is a warning for the operator, not an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { uploadMock, updateMock, eqMock, logActionMock } = vi.hoisted(() => {
  const uploadMock = vi.fn(() => Promise.resolve({ error: null }));
  const eqMock = vi.fn((..._args: unknown[]) => Promise.resolve<{ error: null | { message: string } }>({ error: null }));
  const updateMock = vi.fn((..._args: unknown[]) => ({ eq: eqMock }));
  const logActionMock = vi.fn((..._args: unknown[]) => Promise.resolve());
  return { uploadMock, updateMock, eqMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: uploadMock }) },
    from: () => ({ update: updateMock }),
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { uploadTestReports } from './testReports';

const MAC = '98:a3:16:a6:97:b0';

const report = (serial: string, mac?: string) => new File(
  [
    `# VCycene LILA Test Report\n\n**Serial Number:** ${serial}\n` +
    (mac ? `**MAC ID:** ${mac}\n` : '') +
    `\n## Summary\n- Total Tests: 13\n- Passed: 13\n- Failed: 0\n`,
  ],
  `${serial}.md`,
  { type: 'text/markdown' },
);

const patchFor = (serial: string): Record<string, unknown> => {
  const i = eqMock.mock.calls.findIndex(c => c[0] === 'serial' && c[1] === serial);
  if (i < 0) throw new Error(`no units update for ${serial}`);
  return updateMock.mock.calls[i][0] as Record<string, unknown>;
};

const valid = new Set(['LL01-A', 'LL01-B']);

describe('uploadTestReports — MAC capture', () => {
  beforeEach(() => {
    uploadMock.mockClear(); updateMock.mockClear(); eqMock.mockClear(); logActionMock.mockClear();
  });

  it('writes the normalised MAC to the unit and records it in the activity log', async () => {
    const out = await uploadTestReports([report('LL01-A', '98:A3:16:A6:97:B0')], valid, new Map());
    expect(out[0]).toMatchObject({ serial: 'LL01-A', status: 'paired', result: 'pass', mac: MAC });
    expect(out[0].macClash).toBeUndefined();
    expect(patchFor('LL01-A')).toMatchObject({ mac_address: MAC, electrical_check: 'pass' });
    expect(logActionMock).toHaveBeenCalledWith('unit_test_report', 'LL01-A', `pass mac=${MAC}`);
  });

  it('leaves mac_address untouched when the report has no MAC line', async () => {
    const out = await uploadTestReports([report('LL01-A')], valid, new Map());
    expect(out[0]).toMatchObject({ status: 'paired', mac: null });
    expect(out[0].macClash).toBeUndefined();
    expect(patchFor('LL01-A')).not.toHaveProperty('mac_address');
    expect(logActionMock).toHaveBeenCalledWith('unit_test_report', 'LL01-A', 'pass');
  });

  it('still pairs, but reports a clash, when the MAC already belongs to another serial', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    const out = await uploadTestReports([report('LL01-B', MAC)], valid, owners);
    expect(out[0]).toMatchObject({ serial: 'LL01-B', status: 'paired', mac: MAC, macClash: 'LL01-A' });
    expect(patchFor('LL01-B')).toMatchObject({ mac_address: MAC });
    expect(logActionMock).toHaveBeenCalledWith(
      'unit_mac_duplicate', 'LL01-B', `mac=${MAC} also on LL01-A`,
      { entityType: 'unit', unitSerial: 'LL01-B' },
    );
  });

  it('is not a clash when the same serial re-uploads the same MAC', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    const out = await uploadTestReports([report('LL01-A', MAC)], valid, owners);
    expect(out[0].macClash).toBeUndefined();
    expect(logActionMock.mock.calls.map(c => c[0])).not.toContain('unit_mac_duplicate');
  });

  it('catches two files in one drop that carry the same MAC under different serials', async () => {
    const out = await uploadTestReports([report('LL01-A', MAC), report('LL01-B', MAC)], valid, new Map());
    expect(out[0].macClash).toBeUndefined();
    expect(out[1]).toMatchObject({ serial: 'LL01-B', status: 'paired', macClash: 'LL01-A' });
  });

  it('does not treat a failed write as a seen MAC for later files', async () => {
    eqMock.mockImplementationOnce(() => Promise.resolve({ error: { message: 'boom' } }));
    const out = await uploadTestReports([report('LL01-A', MAC), report('LL01-B', MAC)], valid, new Map());
    expect(out[0].status).toBe('error');
    expect(out[1].macClash).toBeUndefined();
  });

  it('still skips files whose serial is not a known unit', async () => {
    const out = await uploadTestReports([report('LL01-Z', MAC)], valid, new Map());
    expect(out[0].status).toBe('unmatched');
    expect(updateMock).not.toHaveBeenCalled();
  });
});
