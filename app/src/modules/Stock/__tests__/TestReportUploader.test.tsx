// The uploader's results panel: a paired file whose MAC is already on another
// serial shows as a warning (not a problem — it did pair), and a paired file
// with no MAC line gets a quiet note so the operator knows that unit still has
// no MAC on record.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UploadOutcome } from '../../../lib/testReports';

const uploadTestReports = vi.fn(async (..._args: unknown[]): Promise<UploadOutcome[]> => []);
vi.mock('../../../lib/testReports', async () => ({
  ...await vi.importActual<typeof import('../../../lib/testReports')>('../../../lib/testReports'),
  uploadTestReports: (...args: unknown[]) => uploadTestReports(...args),
}));

import { TestReportUploader } from '../TestReportUploader';

const MAC = '98:a3:16:a6:97:b0';
const md = (name: string) => new File(['# report'], name, { type: 'text/markdown' });

const drop = (files: File[]) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};

describe('TestReportUploader — MAC warnings', () => {
  beforeEach(() => uploadTestReports.mockClear());

  it('passes the MAC owner map through to the uploader', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={owners} />);
    drop([md('LL01-A.md')]);
    await waitFor(() => expect(uploadTestReports).toHaveBeenCalled());
    expect(uploadTestReports.mock.calls[0][2]).toBe(owners);
  });

  it('lists a MAC clash as a warning while still counting the file as paired', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-B.md', serial: 'LL01-B', status: 'paired', result: 'pass', mac: MAC, macClash: 'LL01-A' },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A', 'LL01-B'])} macOwners={new Map()} />);
    drop([md('LL01-B.md')]);
    expect(await screen.findByText(/LL01-B → MAC 98:a3:16:a6:97:b0 is already on LL01-A/)).toBeInTheDocument();
    expect(screen.getByText('paired')).toHaveTextContent(/^1 paired/);
  });

  it('notes a paired report that carried no MAC', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-A.md', serial: 'LL01-A', status: 'paired', result: 'pass', mac: null },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={new Map()} />);
    drop([md('LL01-A.md')]);
    expect(await screen.findByText(/LL01-A → no MAC ID in report/)).toBeInTheDocument();
  });

  it('shows no warning list when every paired report had a unique MAC', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-A.md', serial: 'LL01-A', status: 'paired', result: 'pass', mac: MAC },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={new Map()} />);
    drop([md('LL01-A.md')]);
    await screen.findByText('paired');
    expect(screen.queryByText(/already on/)).toBeNull();
    expect(screen.queryByText(/no MAC ID/)).toBeNull();
  });
});
