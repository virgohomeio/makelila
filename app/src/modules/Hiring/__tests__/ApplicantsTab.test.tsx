import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApplicantsTab } from '../ApplicantsTab';
import { useJobPostings, useCandidates, type Candidate, type JobPosting } from '../../../lib/hiring';

// No default returns in the factory: it is hoisted above the consts below, so
// referencing them at factory time would hit the temporal dead zone.
vi.mock('../../../lib/hiring', () => ({
  useJobPostings: vi.fn(),
  useCandidates: vi.fn(),
  updateCandidateStage: vi.fn(),
  recordCandidateScore: vi.fn(),
  rejectCandidate: vi.fn(),
  hireCandidate: vi.fn(),
  getResumeSignedUrl: vi.fn(),
  uploadAndScoreResume: vi.fn(),
}));

const posting: JobPosting = {
  id: 'p1', title: 'Marketing Intern', department: null, location: null, comp_range: null,
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
    screening_invite_sent_at: null, screening_invite_sent_by: null,
    ...over,
  };
}

const roster = [
  candidate({ id: 'c1', full_name: 'Indeed Ida', source: 'indeed' }),
  candidate({ id: 'c2', full_name: 'Waterloo Wes', source: 'university_of_waterloo' }),
  candidate({ id: 'c3', full_name: 'Other Otto', source: 'other' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useJobPostings).mockReturnValue({ postings: [posting], loading: false });
  vi.mocked(useCandidates).mockReturnValue({ candidates: roster, loading: false });
});

function filterSelect() {
  return screen.getByLabelText('Filter by source') as HTMLSelectElement;
}

describe('ApplicantsTab source filter', () => {
  it('lists every candidate until a source is chosen', () => {
    render(<ApplicantsTab onSelectCandidate={() => {}} />);
    expect(filterSelect().value).toBe('all');
    expect(screen.getByText('Indeed Ida')).toBeTruthy();
    expect(screen.getByText('Waterloo Wes')).toBeTruthy();
    expect(screen.getByText('Other Otto')).toBeTruthy();
  });

  it('narrows the list to the chosen source', () => {
    render(<ApplicantsTab onSelectCandidate={() => {}} />);
    fireEvent.change(filterSelect(), { target: { value: 'university_of_waterloo' } });

    expect(screen.getByText('Waterloo Wes')).toBeTruthy();
    expect(screen.queryByText('Indeed Ida')).toBeNull();
    expect(screen.queryByText('Other Otto')).toBeNull();
  });

  it('counts the filtered candidates against the total', () => {
    render(<ApplicantsTab onSelectCandidate={() => {}} />);
    expect(screen.getByText('· 3')).toBeTruthy();

    fireEvent.change(filterSelect(), { target: { value: 'indeed' } });
    expect(screen.getByText('· 1 of 3')).toBeTruthy();
  });

  it('says so when no candidate came from the chosen source', () => {
    render(<ApplicantsTab onSelectCandidate={() => {}} />);
    fireEvent.change(filterSelect(), { target: { value: 'linkedin' } });

    expect(screen.getByText('No applicants from LinkedIn.')).toBeTruthy();
  });

  it('leaves the list alone when the upload source is changed', () => {
    render(<ApplicantsTab onSelectCandidate={() => {}} />);
    fireEvent.change(screen.getByLabelText('Source for uploaded resumes'), { target: { value: 'linkedin' } });

    expect(screen.getByText('Indeed Ida')).toBeTruthy();
    expect(screen.getByText('Waterloo Wes')).toBeTruthy();
    expect(screen.getByText('Other Otto')).toBeTruthy();
  });
});
