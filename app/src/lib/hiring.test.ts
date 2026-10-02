import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useJobPostings, useCandidates, useInterviews,
  createJobPosting, addPostingInterviewer, searchInternalProfiles, getCurrentUserId,
  updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate, recordProjectScores,
  createInterview, recordInterviewDecision, updatePostingRubric,
  suggestScreeningRubric, uploadAndScoreResume, getResumeSignedUrl, getResumeObjectUrl,
  isAssignedInterviewerAnywhere, extractFunctionErrorMessage, getPostingInterviewers,
} from './hiring';

const {
  mockResolve, mockChannel, mockUpdate, mockInsert, mockSingle, mockEq,
  mockGetUser, mockInvoke, mockStorageUpload, mockCreateSignedUrl, mockRemoveChannel,
} = vi.hoisted(() => {
    const mockResolve = vi.fn();
    const mockUnsubscribe = vi.fn();
    const mockOn = vi.fn().mockReturnThis();
    const mockSubscribe = vi.fn().mockReturnThis();
    const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
    const mockRemoveChannel = vi.fn();
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
      mockGetUser, mockInvoke, mockStorageUpload, mockCreateSignedUrl, mockRemoveChannel,
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
      removeChannel: mockRemoveChannel,
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

  it('cleans up by calling supabase.removeChannel, not just channel.unsubscribe', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    const { result, unmount } = renderHook(() => useJobPostings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const channelInstance = mockChannel.mock.results[0]?.value;
    unmount();
    expect(mockRemoveChannel).toHaveBeenCalledWith(channelInstance);
  });

  it('subscribes with a unique channel topic on each mount (StrictMode double-mount safe)', () => {
    mockResolve.mockResolvedValue({ data: [], error: null });
    const { unmount: unmount1 } = renderHook(() => useJobPostings());
    const { unmount: unmount2 } = renderHook(() => useJobPostings());
    expect(mockChannel).toHaveBeenCalledTimes(2);
    const [topic1] = mockChannel.mock.calls[0] as unknown as [string];
    const [topic2] = mockChannel.mock.calls[1] as unknown as [string];
    expect(topic1).not.toBe(topic2);
    unmount1();
    unmount2();
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

  it('cleans up by calling supabase.removeChannel, not just channel.unsubscribe', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    const { result, unmount } = renderHook(() => useCandidates('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const channelInstance = mockChannel.mock.results[0]?.value;
    unmount();
    expect(mockRemoveChannel).toHaveBeenCalledWith(channelInstance);
  });

  it('subscribes with a unique channel topic when two components use the same postingId concurrently', () => {
    mockResolve.mockResolvedValue({ data: [], error: null });
    const { unmount: unmount1 } = renderHook(() => useCandidates('p1'));
    const { unmount: unmount2 } = renderHook(() => useCandidates('p1'));
    expect(mockChannel).toHaveBeenCalledTimes(2);
    const [topic1] = mockChannel.mock.calls[0] as unknown as [string];
    const [topic2] = mockChannel.mock.calls[1] as unknown as [string];
    expect(topic1).not.toBe(topic2);
    unmount1();
    unmount2();
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

  it('rejectCandidate records the resume-screening stage and clears hired_at (switching a shortlisted candidate)', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await rejectCandidate('c1', 'resume_screening');
    expect(mockUpdate).toHaveBeenCalledWith({ rejected_at: expect.any(String), rejection_stage: 'resume_screening', hired_at: null });
  });

  it('rejectCandidate records the interview stage when rejecting from the Interviews board', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await rejectCandidate('c1', 'interview');
    expect(mockUpdate).toHaveBeenCalledWith({ rejected_at: expect.any(String), rejection_stage: 'interview', hired_at: null });
  });

  it('hireCandidate sets hired_at and clears the rejection, stage included (switching a rejected candidate)', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await hireCandidate('c1');
    expect(mockUpdate).toHaveBeenCalledWith({ hired_at: expect.any(String), rejected_at: null, rejection_stage: null });
  });

  it('recordProjectScores writes the project_scores object', async () => {
    mockEq.mockReturnValueOnce({ then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) });
    await recordProjectScores('c1', { 'Question 1': 4, 'Question 2': 5 });
    expect(mockUpdate).toHaveBeenCalledWith({ project_scores: { 'Question 1': 4, 'Question 2': 5 } });
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

  it('getPostingInterviewers resolves the embedded profile into display_name', async () => {
    mockResolve.mockResolvedValueOnce({
      data: [{ id: 'pi1', profile_id: 'u2', profiles: { display_name: 'Reina' } }],
      error: null,
    });
    const result = await getPostingInterviewers('p1');
    expect(result).toEqual([{ id: 'pi1', profile_id: 'u2', display_name: 'Reina' }]);
  });

  it('getPostingInterviewers falls back to "Unknown" when the embedded profile is missing', async () => {
    mockResolve.mockResolvedValueOnce({
      data: [{ id: 'pi1', profile_id: 'u2', profiles: null }],
      error: null,
    });
    const result = await getPostingInterviewers('p1');
    expect(result[0].display_name).toBe('Unknown');
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

  it('suggestScreeningRubric surfaces the edge function\'s real error message, not the generic wrapper text', async () => {
    const genericError = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: { json: () => Promise.resolve({ error: 'This posting has no job_description set — add one before scoring resumes against it.' }) },
    });
    mockInvoke.mockResolvedValueOnce({ data: null, error: genericError });
    await expect(suggestScreeningRubric('')).rejects.toThrow(
      'This posting has no job_description set — add one before scoring resumes against it.',
    );
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

  it('uploadAndScoreResume surfaces parse-resume-batch\'s real error message, not the generic wrapper text', async () => {
    mockStorageUpload.mockResolvedValueOnce({ data: { path: 'p1/abc-resume.pdf' }, error: null });
    const genericError = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: { json: () => Promise.resolve({ error: 'This posting has no job_description set — add one before scoring resumes against it.' }) },
    });
    mockInvoke.mockResolvedValueOnce({ data: null, error: genericError });
    await expect(uploadAndScoreResume({
      postingId: 'p1', file: new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' }), source: 'indeed',
    })).rejects.toThrow('This posting has no job_description set — add one before scoring resumes against it.');
  });

  it('getResumeSignedUrl returns the signed URL', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://.../signed?token=abc' }, error: null });
    const url = await getResumeSignedUrl('p1/abc-resume.pdf');
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('p1/abc-resume.pdf', 3600);
    expect(url).toBe('https://.../signed?token=abc');
  });
});

// The storage response carries a Content-Disposition the browser is free to
// treat as a download — Firefox does, leaving the viewer tab blank. Fetching
// the bytes and handing over a blob: URL takes that decision away from it.
describe('getResumeObjectUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: vi.fn(() => 'blob:makelila/resume') }));
  });

  // Plain-object responses, not `new Response(blob)`: undici's Response treats
  // jsdom's Blob (the global in this test environment) as blob-like and calls
  // .stream() on it, which jsdom's Blob doesn't implement on CI's Node 20 —
  // that TypeError blocked the Pages deploy. Same pattern as lovely.test.ts.
  it('fetches the signed URL and hands back a blob URL', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://storage/signed?token=abc' }, error: null });
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob })));

    expect(await getResumeObjectUrl('p1/abc-resume.pdf')).toBe('blob:makelila/resume');
    expect(fetch).toHaveBeenCalledWith('https://storage/signed?token=abc');
    const passed = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(passed.type).toBe('application/pdf');
  });

  // A resume the browser hands back as octet-stream would download instead of
  // rendering; .pdf paths get the type restored so the viewer takes it.
  it('restores the pdf type when the response has none', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://storage/signed?token=abc' }, error: null });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF-1.4']) })));

    await getResumeObjectUrl('p1/abc-resume.pdf');
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe('application/pdf');
  });

  it('reports the status when the file cannot be fetched', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://storage/signed?token=abc' }, error: null });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));

    await expect(getResumeObjectUrl('p1/abc-resume.pdf')).rejects.toThrow(/403/);
  });
});

describe('isAssignedInterviewerAnywhere', () => {
  it('returns true when a posting_interviewers row exists for the current user', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    mockResolve.mockResolvedValueOnce({ data: [{ id: 'pi1' }], error: null });
    expect(await isAssignedInterviewerAnywhere()).toBe(true);
  });

  it('returns false when no posting_interviewers row exists for the current user', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    expect(await isAssignedInterviewerAnywhere()).toBe(false);
  });

  it('returns false when there is no session (getCurrentUserId returns null)', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect(await isAssignedInterviewerAnywhere()).toBe(false);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('extractFunctionErrorMessage', () => {
  it('extracts the real message from a FunctionsHttpError-shaped error.context Response', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: { json: () => Promise.resolve({ error: 'This posting has no job_description set.' }) },
    });
    const result = await extractFunctionErrorMessage(error);
    expect(result.message).toBe('This posting has no job_description set.');
  });

  it('falls back to the original error when context.json() rejects (not a JSON body)', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: { json: () => Promise.reject(new Error('not json')) },
    });
    const result = await extractFunctionErrorMessage(error);
    expect(result.message).toBe('Edge Function returned a non-2xx status code');
  });

  it('falls back to the original error when the parsed body has no `error` field', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: { json: () => Promise.resolve({ unrelated: 'field' }) },
    });
    const result = await extractFunctionErrorMessage(error);
    expect(result.message).toBe('Edge Function returned a non-2xx status code');
  });

  it('falls back to the original error when it has no `context` property (e.g. FunctionsFetchError-like)', async () => {
    const error = new Error('Failed to send a request to the Edge Function');
    const result = await extractFunctionErrorMessage(error);
    expect(result.message).toBe('Failed to send a request to the Edge Function');
  });

  it('wraps a non-Error value in a new Error', async () => {
    const result = await extractFunctionErrorMessage('plain string error');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('plain string error');
  });
});
