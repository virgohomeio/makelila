import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/** supabase.functions.invoke()'s error.message is always the fixed string
 *  "Edge Function returned a non-2xx status code" — the function's real
 *  {error: "..."} response body sits unconsumed on error.context (a
 *  Response), which nothing was reading. Extracts and rethrows with the
 *  real message; falls back to the original error if the body can't be
 *  read/parsed (e.g. a network-level FunctionsFetchError has no context
 *  Response to read from). */
export async function extractFunctionErrorMessage(error: unknown): Promise<Error> {
  if (error && typeof error === 'object' && 'context' in error) {
    try {
      const context = (error as { context: Response }).context;
      const body = await context.json();
      if (body?.error) return new Error(body.error);
    } catch {
      // context wasn't a Response with a JSON body, or body didn't have
      // an `error` field — fall through to the original error below.
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

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

export type CandidateSource =
  | 'indeed' | 'linkedin' | 'referral' | 'other'
  | 'university_of_waterloo' | 'university_of_toronto' | 'york_university';
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
  /** When an operator marked the screening invite as sent. The invite leaves
   *  from their own mail client, so this is makeLILA's only record that the
   *  candidate has been contacted — an operator marker, not a delivery
   *  receipt. */
  screening_invite_sent_at: string | null;
  screening_invite_sent_by: string | null;
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
  'id, posting_id, full_name, email, phone, source, resume_url, ingested_via, enrichment_status, indeed_relay_email, indeed_dashboard_url, qualifications_tags, stage_index, scores, suggested_scores, applied_at, rejected_at, hired_at, screening_invite_sent_at, screening_invite_sent_by';
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
      .channel(`job_postings:realtime:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_postings' }, () => {
        supabase.from('job_postings').select(POSTING_COLUMNS).order('created_at', { ascending: false })
          .then(({ data }) => { if (data) setPostings(data as JobPosting[]); });
      })
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
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
      .channel(`candidates:${postingId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates', filter: `posting_id=eq.${postingId}` }, () => {
        supabase.from('candidates').select(CANDIDATE_COLUMNS).eq('posting_id', postingId)
          .order('applied_at', { ascending: false })
          .then(({ data }) => { if (data) setCandidates(data as Candidate[]); });
      })
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [postingId]);

  return { candidates, loading };
}

export interface ShortlistedCandidate extends Candidate {
  posting_title: string;
}

/** Every shortlisted candidate the operator can see, across all postings, with
 *  the posting title joined in — the outreach panel's "who still needs an
 *  email?" list.
 *
 *  One query rather than a useCandidates() per posting: the panel sits above a
 *  board that already opens a channel per column, and fanning out a second
 *  round of per-posting queries + channels to render a summary would double
 *  that for no reason. RLS (can_view_posting) scopes the result set, so an
 *  assigned-to-one-posting interviewer sees only their own.
 *
 *  Shortlist derivation matches the board: hired_at set (the shortlist marker)
 *  and a real, resume-attached candidate. */
export function useShortlistedCandidates(): { candidates: ShortlistedCandidate[]; loading: boolean } {
  const [candidates, setCandidates] = useState<ShortlistedCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchRows = async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select(`${CANDIDATE_COLUMNS}, job_postings(title)`)
        .not('hired_at', 'is', null)
        .neq('enrichment_status', 'stub')
        .order('hired_at', { ascending: false });
      if (cancelled || error || !data) return;
      setCandidates(data.map(row => {
        const { job_postings, ...candidate } = row as Candidate & {
          job_postings: { title: string } | { title: string }[] | null;
        };
        // PostgREST returns an embedded to-one relation as an object, but
        // some client/schema-cache combinations hand back a single-element
        // array — normalize both.
        const posting = Array.isArray(job_postings) ? job_postings[0] : job_postings;
        return { ...candidate, posting_title: posting?.title ?? 'Unknown role' };
      }));
    };

    (async () => { await fetchRows(); if (!cancelled) setLoading(false); })();

    const channel = supabase
      .channel(`candidates:shortlist:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates' }, () => { void fetchRows(); })
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, []);

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

/** Org email addresses of internal operators, for the Hiring module's "send
 *  as" picker. Fetched once — the roster changes on the order of months, and
 *  the picker is a small dropdown, not a live view. Sorted by display name so
 *  the list reads the way the team roster does. */
export function useOperatorEmails(): { emails: string[]; loading: boolean } {
  const [emails, setEmails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('email, display_name')
        .eq('is_internal', true)
        .not('email', 'is', null)
        .order('display_name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setEmails((data as { email: string }[]).map(row => row.email));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { emails, loading };
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

export interface PostingInterviewer {
  id: string;           // posting_interviewers row id
  profile_id: string;
  display_name: string;
}

/** Existing (already-persisted) interviewer assignments for a posting —
 *  the "assign interviewer" widget only ever tracked names added in the
 *  current browser session, so reopening a posting (or a second operator
 *  loading the same one) showed no one as assigned even when RLS/the DB
 *  already had real rows, making a duplicate add attempt fail with an
 *  unexplained conflict. `profile_id` has exactly one FK to `profiles`
 *  (added_by references auth.users instead), so the embedded-resource
 *  select is unambiguous with no relationship hint needed. */
export async function getPostingInterviewers(postingId: string): Promise<PostingInterviewer[]> {
  const { data, error } = await supabase
    .from('posting_interviewers')
    .select('id, profile_id, profiles(display_name)')
    .eq('posting_id', postingId);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    profile_id: row.profile_id as string,
    display_name: (row.profiles as unknown as { display_name: string } | null)?.display_name ?? 'Unknown',
  }));
}

/** The signed-in user's id, or null when signed out. Exists so UI
 *  components (e.g. InterviewsTab, Task 12) never import `supabase`
 *  directly — components go through lib/ functions only (AGENTS.md). */
export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** True if the current session user has a posting_interviewers row for
 *  ANY posting — used to admit assigned-but-non-leadership interviewers
 *  into the Hiring module (nav + route), independent of which specific
 *  posting they're assigned to. RLS's can_view_posting() already lets a
 *  user see their own posting_interviewers row (it resolves true for a
 *  row where profile_id = the querying user, since that's exactly what
 *  "assigned interviewer" means), so this query needs no special RLS. */
export async function isAssignedInterviewerAnywhere(): Promise<boolean> {
  const userId = await getCurrentUserId();
  if (!userId) return false;
  const { data, error } = await supabase.from('posting_interviewers').select('id').eq('profile_id', userId).limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Hook wrapper for isAssignedInterviewerAnywhere() — fetches once on
 *  mount. Used by the module-level nav/route gate (App.tsx, GlobalNav.tsx),
 *  not by any per-posting UI (that already goes through canViewPosting()
 *  with a per-posting boolean computed elsewhere). */
export function useIsAssignedInterviewer(): { isAssigned: boolean; loading: boolean } {
  const [isAssigned, setIsAssigned] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await isAssignedInterviewerAnywhere();
      if (!cancelled) { setIsAssigned(result); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  return { isAssigned, loading };
}

/** Calls the suggest-screening-rubric edge function. Components never call
 *  `supabase.functions.invoke` directly — this is the one place that does
 *  for rubric suggestion (same pattern as lib/products.ts's
 *  sendIssueChatMessage wrapping product-issue-chat). */
export async function suggestScreeningRubric(jobDescription: string): Promise<RubricDimension[]> {
  const { data, error } = await supabase.functions.invoke('suggest-screening-rubric', {
    body: { job_description: jobDescription },
  });
  if (error) throw await extractFunctionErrorMessage(error);
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
  if (error) throw await extractFunctionErrorMessage(error);
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

/** Each decision clears the opposing timestamp so a candidate carries at
 *  most one decision tag (Shortlisted/Rejected) and re-clicking the other
 *  button switches it. */
export async function rejectCandidate(candidateId: string): Promise<void> {
  const { error } = await supabase.from('candidates')
    .update({ rejected_at: new Date().toISOString(), hired_at: null }).eq('id', candidateId);
  if (error) throw error;
}

export async function hireCandidate(candidateId: string): Promise<void> {
  const { error } = await supabase.from('candidates')
    .update({ hired_at: new Date().toISOString(), rejected_at: null }).eq('id', candidateId);
  if (error) throw error;
}

/** Records (or clears) "we have emailed this candidate their screening
 *  invite". Set when the operator opens the mail draft from the board, and
 *  settable by hand from the outreach panel for an invite that went out some
 *  other way — or clearable when a draft was abandoned. */
export async function markScreeningInviteSent(candidateId: string, sent: boolean): Promise<void> {
  const userId = sent ? await getCurrentUserId() : null;
  const { error } = await supabase.from('candidates').update({
    screening_invite_sent_at: sent ? new Date().toISOString() : null,
    screening_invite_sent_by: userId,
  }).eq('id', candidateId);
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

/** Resolves a stored hiring-resumes storage path (candidates.resume_url) to
 *  a time-limited signed URL for viewing. Generated at read time, not
 *  write time, since signed URLs expire — see Task 6's review. */
export async function getResumeSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('hiring-resumes').createSignedUrl(storagePath, 3600);
  if (error || !data) throw error ?? new Error('getResumeSignedUrl: no signed URL returned');
  return data.signedUrl;
}
