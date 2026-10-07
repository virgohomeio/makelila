import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CandidateCard } from '../ApplicantsTab';
import { hireCandidate, rejectCandidate, getResumeObjectUrl, type Candidate } from '../../../lib/hiring';

vi.mock('../../../lib/hiring', () => ({
  useJobPostings: vi.fn(() => ({ postings: [], loading: false })),
  useCandidates: vi.fn(() => ({ candidates: [], loading: false })),
  updateCandidateStage: vi.fn(),
  recordCandidateScore: vi.fn(),
  rejectCandidate: vi.fn(),
  hireCandidate: vi.fn(),
  getResumeObjectUrl: vi.fn(),
  uploadAndScoreResume: vi.fn(),
}));

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    posting_id: 'p1', full_name: 'Jenivan Sivakumaru', email: 'j@example.com', phone: null,
    source: 'indeed', resume_url: 'p1/resume.pdf', ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached', indeed_relay_email: null, indeed_dashboard_url: null,
    qualifications_tags: [], stage_index: 0, scores: {}, suggested_scores: null, project_scores: {},
    applied_at: '2026-07-01T00:00:00Z', rejected_at: null, rejection_stage: null, hired_at: null,
    screening_invite_sent_at: null, screening_invite_sent_by: null,
    ...over,
  };
}

const stages = ['Applied', 'Screen', 'Interview'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('CandidateCard decision tags', () => {
  it('shows no decision tag when the candidate is undecided', () => {
    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    expect(screen.queryByText('Shortlisted')).toBeNull();
    expect(screen.queryByText(/Rejected —/)).toBeNull();
  });

  it('shows a Shortlisted tag when hired_at is set', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Shortlisted')).toBeTruthy();
    expect(screen.queryByText(/Rejected —/)).toBeNull();
  });

  it('labels a resume-screening rejection as such', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', rejected_at: '2026-07-30T00:00:00Z', rejection_stage: 'resume_screening' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Rejected — resume screen')).toBeTruthy();
    expect(screen.queryByText('Shortlisted')).toBeNull();
  });

  it('labels an interview-stage rejection as such', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', rejected_at: '2026-07-30T00:00:00Z', rejection_stage: 'interview' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Rejected — interview')).toBeTruthy();
    expect(screen.queryByText('Shortlisted')).toBeNull();
  });

  // Rows rejected before rejection_stage existed all came from this board.
  it('treats a legacy rejection with no stage as a resume-screening one', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', rejected_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Rejected — resume screen')).toBeTruthy();
  });

  it('shows Shortlisted (not Rejected) when a legacy row has both timestamps', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z', rejected_at: '2026-07-29T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Shortlisted')).toBeTruthy();
    expect(screen.queryByText(/Rejected —/)).toBeNull();
  });

  it('labels the shortlist button "Shortlist" and it calls hireCandidate', () => {
    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shortlist' }));
    expect(hireCandidate).toHaveBeenCalledWith('c1');
  });

  // InterviewsTab lists shortlisted candidates only, so the jump would land on
  // a board that doesn't show this candidate.
  it('disables the Interviews jump until the candidate is shortlisted', () => {
    const onSelect = vi.fn();
    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={onSelect} />);
    const button = screen.getByRole('button', { name: 'Interviews →' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enables the Interviews jump for a shortlisted candidate', () => {
    const onSelect = vi.fn();
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={onSelect}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Interviews →' }));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('keeps both decision buttons active after a decision (switching stays possible)', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    const rejectButton = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(false);
    fireEvent.click(rejectButton);
    expect(rejectCandidate).toHaveBeenCalledWith('c1', 'resume_screening');
  });
});

describe('CandidateCard resume viewing', () => {
  /** A stand-in for the tab window.open hands back. */
  function fakeTab() {
    return { location: { href: '' }, opener: {} as unknown, close: vi.fn() };
  }

  // A blob: URL, not the signed one: Firefox saves the storage response instead
  // of rendering it, which left the tab blank.
  it('points a newly opened tab at the resume blob URL', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(getResumeObjectUrl).mockResolvedValue('blob:makelila/resume');

    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'View resume' }));

    expect(getResumeObjectUrl).toHaveBeenCalledWith('p1/resume.pdf');
    await waitFor(() => expect(tab.location.href).toBe('blob:makelila/resume'));
  });

  // The tab has to be opened during the click itself. Opening it after the
  // signed-URL round trip leaves it to the popup blocker's discretion, and the
  // old code ignored the return value, so a blocked tab looked like a dead
  // button — which is exactly what it felt like.
  it('opens the tab during the click, before the file is fetched', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(fakeTab() as unknown as Window);
    let resolveUrl: (url: string) => void = () => {};
    vi.mocked(getResumeObjectUrl).mockReturnValue(new Promise<string>(res => { resolveUrl = res; }));

    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'View resume' }));

    expect(open).toHaveBeenCalled();
    resolveUrl('https://storage.example/signed/resume.pdf');
  });

  it('says the browser blocked the tab rather than failing silently', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(getResumeObjectUrl).mockResolvedValue('https://storage.example/signed/resume.pdf');

    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'View resume' }));

    expect(await screen.findByText(/blocked/i)).toBeTruthy();
  });

  it('surfaces why the resume could not be fetched instead of a generic retry message', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(getResumeObjectUrl).mockRejectedValue(new Error('Object not found'));

    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'View resume' }));

    expect(await screen.findByText(/Object not found/)).toBeTruthy();
    // The blank tab shouldn't be left sitting there once the fetch failed.
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
  });

  it('offers no resume button when the candidate has no file', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', resume_url: null })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.queryByRole('button', { name: 'View resume' })).toBeNull();
  });

  it('is unreachable for a stub candidate, who has no resume yet', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', enrichment_status: 'stub' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.queryByRole('button', { name: 'View resume' })).toBeNull();
  });
});
