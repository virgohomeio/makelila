import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useJobPostings, useCandidates, useInterviews,
  createJobPosting, addPostingInterviewer, searchInternalProfiles, getCurrentUserId,
  updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  createInterview, recordInterviewDecision, updatePostingRubric,
  suggestScreeningRubric, uploadAndScoreResume, getResumeSignedUrl,
} from './hiring';

const {
  mockResolve, mockChannel, mockUpdate, mockInsert, mockSingle, mockEq,
  mockGetUser, mockInvoke, mockStorageUpload, mockCreateSignedUrl,
} = vi.hoisted(() => {
    const mockResolve = vi.fn();
    const mockUnsubscribe = vi.fn();
    const mockOn = vi.fn().mockReturnThis();
    const mockSubscribe = vi.fn().mockReturnThis();
    const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
    const mockSingle = vi.fn();
    const mockEq = vi.fn((): { single?: typeof mockSingle; then?: (onFulfilled: (v: unknown) => unknown) => unknown } => ({ single: mockSingle }));
    const mockUpdate = vi.fn(() => ({ eq: mockEq }));
    const mockInsert = vi.fn(() => ({ select: () => ({ single: mockSingle }) }));
    const mockGetUser = vi.fn();
    const mockInvoke = vi.fn();
    const mockStorageUpload = vi.fn();
    const mockCreateSignedUrl = vi.fn();
    return {
      mockResolve, mockChannel, mockUpdate, mockInsert, mockSingle, mockEq,
      mockGetUser, mockInvoke, mockStorageUpload, mockCreateSignedUrl,
    };
  });

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.ilike = () => builder;
  builder.limit = () => builder;
  builder.order = () => builder;
  builder.update = mockUpdate;
  builder.insert = mockInsert;
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    mockResolve().then(onFulfilled, onRejected);
  return {
    supabase: {
      from: () => builder,
      channel: mockChannel,
      auth: { getUser: mockGetUser },
      functions: { invoke: mockInvoke },
      storage: { from: () => ({ upload: mockStorageUpload, createSignedUrl: mockCreateSignedUrl }) },
    },
  };
});

beforeEach(() => vi.clearAllMocks());

describe('useJobPostings', () => {
  it('loads postings and stops loading', async () => {
    mockResolve.mockResolvedValueOnce({ data: [{ id: 'p1', title: 'LILA Ops' }], error: null });
    const { result } = renderHook(() => useJobPostings());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.postings).toHaveLength(1);
  });
});

describe('useCandidates', () => {
  it('returns empty array and does not query when postingId is null', () => {
    const { result } = renderHook(() => useCandidates(null));
    expect(result.current.candidates).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('loads candidates for a posting', async () => {
    mockResolve.mockResolvedValueOnce({ data: [{ id: 'c1', full_name: 'Jenivan S' }], error: null });
    const { result } = renderHook(() => useCandidates('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.candidates).toHaveLength(1);
  });
});

describe('useInterviews', () => {
  it('loads interviews for a candidate and stops loading', async () => {
    mockResolve.mockResolvedValueOnce({ data: [{ id: 'i1', candidate_id: 'c1', round_label: 'Screen' }], error: null });
    const { result } = renderHook(() => useInterviews('c1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.interviews).toHaveLength(1);
  });
});

describe('mutations', () => {
  it('updateCandidateStage updates stage_index', async () => {
    mockEq.mockReturnValueOnce({ single: mockSingle, then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await updateCandidateStage('c1', 2);
    expect(mockUpdate).toHaveBeenCalledWith({ stage_index: 2 });
  });

  it('recordCandidateScore writes the scores object', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await recordCandidateScore('c1', { culture_fit: 4 });
    expect(mockUpdate).toHaveBeenCalledWith({ scores: { culture_fit: 4 } });
  });

  it('rejectCandidate sets rejected_at', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await rejectCandidate('c1');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ rejected_at: expect.any(String) }));
  });

  it('hireCandidate sets hired_at', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await hireCandidate('c1');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ hired_at: expect.any(String) }));
  });

  it('createInterview inserts a row and returns it', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'i1', candidate_id: 'c1', round_label: 'Screen' }, error: null });
    const result = await createInterview({ candidateId: 'c1', roundLabel: 'Screen', interviewerId: 'u1' });
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: 'c1', round_label: 'Screen' }));
    expect(result.id).toBe('i1');
  });

  it('recordInterviewDecision writes decision + notes + decided_at', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await recordInterviewDecision('i1', 'advance', 'Strong technical round');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'advance', decision_notes: 'Strong technical round', decided_at: expect.any(String),
    }));
  });

  it('updatePostingRubric writes screening_rubric', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await updatePostingRubric('p1', [{ dimension: 'Experience', weight_pct: 40 }]);
    expect(mockUpdate).toHaveBeenCalledWith({ screening_rubric: [{ dimension: 'Experience', weight_pct: 40 }] });
  });

  it('createJobPosting inserts a row and returns it', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'p1', title: 'Ops Specialist' }, error: null });
    const result = await createJobPosting({ title: 'Ops Specialist' });
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ops Specialist' }));
    expect(result.id).toBe('p1');
  });

  it('addPostingInterviewer inserts a posting_interviewers row', async () => {
    await addPostingInterviewer('p1', 'u2');
    expect(mockInsert).toHaveBeenCalledWith({ posting_id: 'p1', profile_id: 'u2' });
  });

  it('searchInternalProfiles returns matching profiles', async () => {
    mockResolve.mockResolvedValueOnce({ data: [{ id: 'u2', display_name: 'Reina' }], error: null });
    const result = await searchInternalProfiles('reina');
    expect(result).toHaveLength(1);
    expect(result[0].display_name).toBe('Reina');
  });

  it('getCurrentUserId returns the session user id, or null when signed out', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    expect(await getCurrentUserId()).toBe('u1');
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect(await getCurrentUserId()).toBeNull();
  });

  it('suggestScreeningRubric invokes the edge function and returns its rubric', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { rubric: [{ dimension: 'Logistics', weight_pct: 100 }] }, error: null });
    const result = await suggestScreeningRubric('We need a warehouse coordinator...');
    expect(mockInvoke).toHaveBeenCalledWith('suggest-screening-rubric', {
      body: { job_description: 'We need a warehouse coordinator...' },
    });
    expect(result).toEqual([{ dimension: 'Logistics', weight_pct: 100 }]);
  });

  it('uploadAndScoreResume uploads to storage then invokes parse-resume-batch', async () => {
    mockStorageUpload.mockResolvedValueOnce({ data: { path: 'p1/abc-resume.pdf' }, error: null });
    mockInvoke.mockResolvedValueOnce({
      data: { candidate_id: 'c1', full_name: 'Jenivan Sivakumaru', email: 'j@example.com', phone: null, suggested_scores: { Logistics: 4 }, enrichment_status: 'resume_attached' },
      error: null,
    });
    const result = await uploadAndScoreResume({
      postingId: 'p1', file: new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' }), source: 'indeed',
    });
    expect(mockStorageUpload).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith('parse-resume-batch', expect.objectContaining({
      body: expect.objectContaining({ posting_id: 'p1', mime_type: 'application/pdf', source: 'indeed' }),
    }));
    expect(result.candidate_id).toBe('c1');
  });

  it('uploadAndScoreResume throws when the storage upload fails, without calling parse-resume-batch', async () => {
    mockStorageUpload.mockResolvedValueOnce({ data: null, error: { message: 'quota exceeded' } });
    await expect(uploadAndScoreResume({
      postingId: 'p1', file: new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' }), source: 'indeed',
    })).rejects.toEqual({ message: 'quota exceeded' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('getResumeSignedUrl returns the signed URL', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://.../signed?token=abc' }, error: null });
    const url = await getResumeSignedUrl('p1/abc-resume.pdf');
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('p1/abc-resume.pdf', 3600);
    expect(url).toBe('https://.../signed?token=abc');
  });
});
