import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CandidateCard } from '../ApplicantsTab';
import { hireCandidate, rejectCandidate, type Candidate } from '../../../lib/hiring';

vi.mock('../../../lib/hiring', () => ({
  useJobPostings: vi.fn(() => ({ postings: [], loading: false })),
  useCandidates: vi.fn(() => ({ candidates: [], loading: false })),
  updateCandidateStage: vi.fn(),
  recordCandidateScore: vi.fn(),
  rejectCandidate: vi.fn(),
  hireCandidate: vi.fn(),
  getResumeSignedUrl: vi.fn(),
  uploadAndScoreResume: vi.fn(),
}));

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    posting_id: 'p1', full_name: 'Jenivan Sivakumaru', email: 'j@example.com', phone: null,
    source: 'indeed', resume_url: 'p1/resume.pdf', ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached', indeed_relay_email: null, indeed_dashboard_url: null,
    qualifications_tags: [], stage_index: 0, scores: {}, suggested_scores: null,
    applied_at: '2026-07-01T00:00:00Z', rejected_at: null, hired_at: null,
    ...over,
  };
}

const stages = ['Applied', 'Screen', 'Interview'];

beforeEach(() => vi.clearAllMocks());

describe('CandidateCard decision tags', () => {
  it('shows no decision tag when the candidate is undecided', () => {
    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    expect(screen.queryByText('Shortlisted')).toBeNull();
    expect(screen.queryByText('Rejected')).toBeNull();
  });

  it('shows a Shortlisted tag when hired_at is set', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Shortlisted')).toBeTruthy();
    expect(screen.queryByText('Rejected')).toBeNull();
  });

  it('shows a Rejected tag when rejected_at is set', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', rejected_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.queryByText('Shortlisted')).toBeNull();
  });

  it('shows Shortlisted (not Rejected) when a legacy row has both timestamps', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z', rejected_at: '2026-07-29T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    expect(screen.getByText('Shortlisted')).toBeTruthy();
    expect(screen.queryByText('Rejected')).toBeNull();
  });

  it('labels the shortlist button "Shortlist" and it calls hireCandidate', () => {
    render(<CandidateCard candidate={candidate({ id: 'c1' })} pipelineStages={stages} onSelectCandidate={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shortlist' }));
    expect(hireCandidate).toHaveBeenCalledWith('c1');
  });

  it('keeps both decision buttons active after a decision (switching stays possible)', () => {
    render(<CandidateCard
      candidate={candidate({ id: 'c1', hired_at: '2026-07-30T00:00:00Z' })}
      pipelineStages={stages} onSelectCandidate={() => {}}
    />);
    const rejectButton = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(false);
    fireEvent.click(rejectButton);
    expect(rejectCandidate).toHaveBeenCalledWith('c1');
  });
});
