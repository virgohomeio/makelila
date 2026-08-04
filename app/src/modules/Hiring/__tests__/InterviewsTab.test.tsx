import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InterviewsTab } from '../InterviewsTab';
import { useCandidates, type Candidate, type JobPosting } from '../../../lib/hiring';

vi.mock('../../../lib/hiring', () => ({
  useJobPostings: vi.fn(() => ({ postings: [posting], loading: false })),
  useCandidates: vi.fn(() => ({ candidates: [], loading: false })),
  useInterviews: vi.fn(() => ({ interviews: [], loading: false })),
  createInterview: vi.fn(),
  recordInterviewDecision: vi.fn(),
  getCurrentUserId: vi.fn(),
}));

const posting: JobPosting = {
  id: 'p1', title: 'Fulfillment Associate', department: null, location: null, comp_range: null,
  status: 'open', indeed_url: null, linkedin_url: null, job_description: null,
  screening_rubric: [], pipeline_stages: ['Applied', 'Screen', 'Interview'],
  created_at: '2026-07-01T00:00:00Z',
};

function candidate(over: Partial<Candidate> & { id: string; full_name: string }): Candidate {
  return {
    posting_id: 'p1', email: null, phone: null,
    source: 'indeed', resume_url: 'p1/resume.pdf', ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached', indeed_relay_email: null, indeed_dashboard_url: null,
    qualifications_tags: [], stage_index: 0, scores: {}, suggested_scores: null,
    applied_at: '2026-07-01T00:00:00Z', rejected_at: null, hired_at: null,
    ...over,
  };
}

function withCandidates(candidates: Candidate[]) {
  vi.mocked(useCandidates).mockReturnValue({ candidates, loading: false });
}

beforeEach(() => vi.clearAllMocks());

describe('InterviewsTab candidate list', () => {
  it('lists only shortlisted candidates', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
      candidate({ id: 'c2', full_name: 'Undecided Uma' }),
      candidate({ id: 'c3', full_name: 'Rejected Rita', rejected_at: '2026-07-30T00:00:00Z' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Shortlisted Sam')).toBeTruthy();
    expect(screen.queryByText('Undecided Uma')).toBeNull();
    expect(screen.queryByText('Rejected Rita')).toBeNull();
  });

  it('excludes stub candidates even when shortlisted', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Stub Steve', enrichment_status: 'stub',
        hired_at: '2026-07-30T00:00:00Z',
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.queryByText('Stub Steve')).toBeNull();
  });

  it('counts only the shortlisted candidates in the column header', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
      candidate({ id: 'c2', full_name: 'Undecided Uma' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('· 1')).toBeTruthy();
  });

  it('shows the saved scores as text beside the candidate name', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z',
        scores: { Communication: 4, Reliability: 5 },
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Communication 4 · Reliability 5')).toBeTruthy();
  });

  it('falls back to suggested scores, with saved scores taking precedence', () => {
    withCandidates([
      candidate({
        id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z',
        suggested_scores: { Communication: 2, Reliability: 3 },
        scores: { Communication: 4 },
      }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('Communication 4 · Reliability 3')).toBeTruthy();
  });

  it('says so when a shortlisted candidate has no scores yet', () => {
    withCandidates([
      candidate({ id: 'c1', full_name: 'Shortlisted Sam', hired_at: '2026-07-30T00:00:00Z' }),
    ]);
    render(<InterviewsTab />);
    expect(screen.getByText('No scores yet')).toBeTruthy();
  });
});
