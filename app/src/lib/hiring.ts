import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type PostingStatus = 'open' | 'on_hold' | 'closed';
export type RubricDimension = { dimension: string; weight_pct: number };

export interface JobPosting {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  comp_range: string | null;
  status: PostingStatus;
  indeed_url: string | null;
  linkedin_url: string | null;
  job_description: string | null;
  screening_rubric: RubricDimension[];
  pipeline_stages: string[];
  created_at: string;
}

export type CandidateSource = 'indeed' | 'linkedin' | 'referral' | 'other';
export type IngestedVia = 'email_sync' | 'manual_upload';
export type EnrichmentStatus = 'stub' | 'resume_attached';

export interface Candidate {
  id: string;
  posting_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  source: CandidateSource;
  resume_url: string | null;
  ingested_via: IngestedVia;
  enrichment_status: EnrichmentStatus;
  indeed_relay_email: string | null;
  indeed_dashboard_url: string | null;
  qualifications_tags: string[];
  stage_index: number;
  scores: Record<string, number>;
  suggested_scores: Record<string, number> | null;
  applied_at: string;
  rejected_at: string | null;
  hired_at: string | null;
}

export type InterviewDecision = 'advance' | 'reject' | 'hold' | 'no_show';

export interface Interview {
  id: string;
  candidate_id: string;
  round_label: string;
  interviewer_id: string | null;
  calendly_event_uri: string | null;
  scheduled_at: string | null;
  held_at: string | null;
  decision: InterviewDecision | null;
  decision_notes: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

const POSTING_COLUMNS =
  'id, title, department, location, comp_range, status, indeed_url, linkedin_url, job_description, screening_rubric, pipeline_stages, created_at';
const CANDIDATE_COLUMNS =
  'id, posting_id, full_name, email, phone, source, resume_url, ingested_via, enrichment_status, indeed_relay_email, indeed_dashboard_url, qualifications_tags, stage_index, scores, suggested_scores, applied_at, rejected_at, hired_at';
const INTERVIEW_COLUMNS =
  'id, candidate_id, round_label, interviewer_id, calendly_event_uri, scheduled_at, held_at, decision, decision_notes, decided_by, decided_at';

export function useJobPostings(): { postings: JobPosting[]; loading: boolean } {
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('job_postings')
        .select(POSTING_COLUMNS)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setPostings(data as JobPosting[]);
      setLoading(false);
    })();
    const channel = supabase
      .channel('job_postings:realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_postings' }, () => {
        supabase.from('job_postings').select(POSTING_COLUMNS).order('created_at', { ascending: false })
          .then(({ data }) => { if (data) setPostings(data as JobPosting[]); });
      })
      .subscribe();
    return () => { cancelled = true; void channel.unsubscribe(); };
  }, []);

  return { postings, loading };
}

/** Live candidates for one posting. Pass null when no posting is selected
 *  yet — returns immediately with an empty list and no query fired. */
export function useCandidates(postingId: string | null): { candidates: Candidate[]; loading: boolean } {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!postingId) { setCandidates([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select(CANDIDATE_COLUMNS)
        .eq('posting_id', postingId)
        .order('applied_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setCandidates(data as Candidate[]);
      setLoading(false);
    })();
    const channel = supabase
      .channel(`candidates:${postingId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates', filter: `posting_id=eq.${postingId}` }, () => {
        supabase.from('candidates').select(CANDIDATE_COLUMNS).eq('posting_id', postingId)
          .order('applied_at', { ascending: false })
          .then(({ data }) => { if (data) setCandidates(data as Candidate[]); });
      })
      .subscribe();
    return () => { cancelled = true; void channel.unsubscribe(); };
  }, [postingId]);

  return { candidates, loading };
}

export function useInterviews(candidateId: string): { interviews: Interview[]; loading: boolean } {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(INTERVIEW_COLUMNS)
        .eq('candidate_id', candidateId)
        .order('scheduled_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setInterviews(data as Interview[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [candidateId]);

  return { interviews, loading };
}

export async function updatePostingRubric(postingId: string, rubric: RubricDimension[]): Promise<void> {
  const { error } = await supabase.from('job_postings').update({ screening_rubric: rubric }).eq('id', postingId);
  if (error) throw error;
}

export async function createJobPosting(input: {
  title: string; department?: string; location?: string; comp_range?: string;
  indeed_url?: string; linkedin_url?: string; job_description?: string;
}): Promise<JobPosting> {
  const { data, error } = await supabase
    .from('job_postings')
    .insert({
      title: input.title,
      department: input.department ?? null,
      location: input.location ?? null,
      comp_range: input.comp_range ?? null,
      indeed_url: input.indeed_url ?? null,
      linkedin_url: input.linkedin_url ?? null,
      job_description: input.job_description ?? null,
    })
    .select(POSTING_COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error('createJobPosting: no row returned');
  return data as JobPosting;
}

export interface InternalProfile {
  id: string;
  display_name: string;
}

/** Looks up internal profiles by display-name substring, for the "assign
 *  an interviewer" widget on the Postings tab (Task 10). `profiles` has no
 *  `email` column (email lives on `auth.users`, not exposed via the
 *  client-side query surface) — name search is the available option.
 *  Only leadership can reach this UI in practice (gated by
 *  canView('hiring')). */
export async function searchInternalProfiles(nameQuery: string): Promise<InternalProfile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name')
    .ilike('display_name', `%${nameQuery}%`)
    .limit(10);
  if (error) throw error;
  return (data ?? []) as InternalProfile[];
}

export async function addPostingInterviewer(postingId: string, profileId: string): Promise<void> {
  const { error } = await supabase.from('posting_interviewers').insert({ posting_id: postingId, profile_id: profileId });
  if (error) throw error;
}

/** The signed-in user's id, or null when signed out. Exists so UI
 *  components (e.g. InterviewsTab, Task 12) never import `supabase`
 *  directly — components go through lib/ functions only (AGENTS.md). */
export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Calls the suggest-screening-rubric edge function. Components never call
 *  `supabase.functions.invoke` directly — this is the one place that does
 *  for rubric suggestion (same pattern as lib/products.ts's
 *  sendIssueChatMessage wrapping product-issue-chat). */
export async function suggestScreeningRubric(jobDescription: string): Promise<RubricDimension[]> {
  const { data, error } = await supabase.functions.invoke('suggest-screening-rubric', {
    body: { job_description: jobDescription },
  });
  if (error) throw error;
  return (data as { rubric: RubricDimension[] }).rubric;
}

export type ParseResumeResult = {
  candidate_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  suggested_scores: Record<string, number>;
  enrichment_status: EnrichmentStatus;
};

/** Uploads a resume file to the hiring-resumes bucket, then invokes
 *  parse-resume-batch to extract/score it. Components (ResumeUploadPanel,
 *  Task 11) call only this — never `supabase.storage` or
 *  `supabase.functions.invoke` directly. */
export async function uploadAndScoreResume(input: {
  postingId: string; file: File; source: CandidateSource;
}): Promise<ParseResumeResult> {
  const path = `${input.postingId}/${crypto.randomUUID()}-${input.file.name}`;
  const { error: uploadErr } = await supabase.storage.from('hiring-resumes').upload(path, input.file);
  if (uploadErr) throw uploadErr;

  const { data, error } = await supabase.functions.invoke('parse-resume-batch', {
    body: { posting_id: input.postingId, storage_path: path, mime_type: input.file.type, source: input.source },
  });
  if (error) throw error;
  return data as ParseResumeResult;
}

export async function updateCandidateStage(candidateId: string, stageIndex: number): Promise<void> {
  const { error } = await supabase.from('candidates').update({ stage_index: stageIndex }).eq('id', candidateId);
  if (error) throw error;
}

export async function recordCandidateScore(candidateId: string, scores: Record<string, number>): Promise<void> {
  const { error } = await supabase.from('candidates').update({ scores }).eq('id', candidateId);
  if (error) throw error;
}

export async function rejectCandidate(candidateId: string): Promise<void> {
  const { error } = await supabase.from('candidates')
    .update({ rejected_at: new Date().toISOString() }).eq('id', candidateId);
  if (error) throw error;
}

export async function hireCandidate(candidateId: string): Promise<void> {
  const { error } = await supabase.from('candidates')
    .update({ hired_at: new Date().toISOString() }).eq('id', candidateId);
  if (error) throw error;
}

export async function createInterview(input: {
  candidateId: string; roundLabel: string; interviewerId: string; calendlyUrl?: string;
}): Promise<Interview> {
  const { data, error } = await supabase
    .from('interviews')
    .insert({
      candidate_id: input.candidateId,
      round_label: input.roundLabel,
      interviewer_id: input.interviewerId,
      calendly_event_uri: input.calendlyUrl ?? null,
    })
    .select(INTERVIEW_COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error('createInterview: no row returned');
  return data as Interview;
}

export async function recordInterviewDecision(
  interviewId: string, decision: InterviewDecision, notes: string,
): Promise<void> {
  const { error } = await supabase.from('interviews').update({
    decision, decision_notes: notes, decided_at: new Date().toISOString(),
  }).eq('id', interviewId);
  if (error) throw error;
}
