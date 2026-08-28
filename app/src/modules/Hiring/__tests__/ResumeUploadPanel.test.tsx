import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ResumeUploadPanel } from '../ResumeUploadPanel';
import { uploadAndScoreResume, type ParseResumeResult } from '../../../lib/hiring';

vi.mock('../../../lib/hiring', () => ({ uploadAndScoreResume: vi.fn() }));

const result = (over: Partial<ParseResumeResult>): ParseResumeResult => ({
  candidate_id: 'c1', full_name: 'Ada Lovelace', email: 'ada@example.com', phone: null,
  suggested_scores: {}, enrichment_status: 'resume_attached', duplicate: false, ...over,
});

/** Drops one PDF on the panel the way the hidden file input receives it. */
function dropResume(container: HTMLElement) {
  const input = container.querySelector('#hiring-resume-input') as HTMLInputElement;
  const file = new File(['%PDF-1.4'], 'ada-lovelace.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => vi.clearAllMocks());

describe('ResumeUploadPanel duplicate handling', () => {
  it('files a new applicant when the resume is one nobody has uploaded', async () => {
    vi.mocked(uploadAndScoreResume).mockResolvedValue(result({}));
    const { container } = render(<ResumeUploadPanel postingId="p1" source="indeed" onUploaded={() => {}} />);
    dropResume(container);
    expect(await screen.findByText('Filed: Ada Lovelace')).toBeTruthy();
  });

  it('says the applicant is already on the board instead of reporting a second filing', async () => {
    vi.mocked(uploadAndScoreResume).mockResolvedValue(result({ duplicate: true }));
    const { container } = render(<ResumeUploadPanel postingId="p1" source="indeed" onUploaded={() => {}} />);
    dropResume(container);
    expect(await screen.findByText('Already on the board: Ada Lovelace')).toBeTruthy();
    expect(screen.queryByText('Filed: Ada Lovelace')).toBeNull();
  });

  it('still refreshes the board after a duplicate, so the operator sees the existing row', async () => {
    vi.mocked(uploadAndScoreResume).mockResolvedValue(result({ duplicate: true }));
    const onUploaded = vi.fn();
    const { container } = render(<ResumeUploadPanel postingId="p1" source="indeed" onUploaded={onUploaded} />);
    dropResume(container);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
  });
});
