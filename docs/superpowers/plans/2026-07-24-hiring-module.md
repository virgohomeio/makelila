# Hiring Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Hiring module (PRD §4.15) — job postings with JD-derived screening rubrics, a two-path applicant pipeline (Indeed email stub-creation + batch resume upload as the primary path to a full record), Calendly-booked interviews with recorded decisions, and leadership-plus-assigned-interviewer visibility — replacing the current manual Indeed/LinkedIn workflow (`07_People_Hiring/ops/indeed/`, `ops/linkedin/`, hand-built markdown scorecards).

**Architecture:** Four new Postgres tables (`job_postings`, `candidates`, `posting_interviewers`, `interviews`) behind a `can_view_posting()` RLS helper mirroring the existing `is_finance()` leadership pattern. Two ingestion paths write to the same `candidates` table: a cron-driven `sync-hiring-applications` edge function creates lightweight **stub** rows from Indeed's real (verified) notification-email format on the shared `support@virgohome.io` mailbox; a user-triggered `parse-resume-batch` edge function sends uploaded resume files directly to Claude (document content blocks) to extract real contact info and produce a JD-grounded auto-score, enriching a matching stub or creating a new record. A `suggest-screening-rubric` edge function lets Claude propose rubric dimensions from a job description. A pg_cron-scheduled `purge-stale-candidates` function enforces the 1-year rejected-candidate retention policy. UI is a fourth top-level module (`Hiring`) with Postings/Applicants/Interviews tabs, gated by the same three-layer RBAC pattern as the Finance module (nav-hide + route guard + RLS).

**Tech Stack:** React 18 + TypeScript (Vite), Supabase Postgres + Auth + Realtime + Storage + Edge Functions (Deno), Supabase JS client v2.103.3, Anthropic Messages API (`claude-haiku-4-5`, PDF document content blocks), Google Workspace service-account domain-wide delegation (Gmail API, reused from `sync-gmail-tickets`), Calendly API (reused from `sync-calendly-events`), Vitest + Deno test.

## Global Constraints

- Deno edge function imports: `https://esm.sh/@supabase/supabase-js@2.45.0`, `https://esm.sh/jose@5.9.6` (only in `_shared/gmail-auth.ts`, matching the existing extraction precedent in `_shared/google-calendar.ts`)
- Auth: use `authenticate()` from `../_shared/auth.ts` and `corsHeaders` from `../_shared/cors.ts` — identical to every existing function
- User-JWT-only functions (`parse-resume-batch`, `suggest-screening-rubric`) reject `caller.kind !== 'user'`, matching `verify-address`
- Cron-only functions (`sync-hiring-applications`, `purge-stale-candidates`) reject `caller.kind !== 'cron'`, matching `sync-calendly-events`
- RLS pattern: reuse `public.is_finance()` (already means "finance or admin" — semantically identical to the TS `isLeadership()` helper) plus a new `public.can_view_posting(p_posting_id uuid)` helper for per-posting interviewer access
- Anthropic secret name: `ANTHROPIC_API_KEY` — already a Supabase secret per `verify-address`; never hardcoded
- Anthropic model: `claude-haiku-4-5`, matching `verify-address`'s existing choice
- Migration filename convention: `20260724NNNNNN_<name>.sql`
- All lib hooks follow `app/src/lib/kms.ts` / `app/src/lib/products.ts`: named export, typed return, `supabase` imported from `./supabase`
- Components never call `supabase` directly (AGENTS.md convention) — always through a `lib/` function
- CLI commands run from `app/`: `./node_modules/.bin/supabase <subcommand>`
- Vitest commands run from `app/`: `npx vitest run <path>`
- Deno test commands run from repo root: `deno test <path> --allow-net`

---

## File Structure

```
supabase/
  migrations/
    20260724130000_hiring_schema.sql          ← new: 4 tables + RLS + can_view_posting() + activity_entity_type values
    20260724130100_hiring_resumes_bucket.sql  ← new: private Storage bucket + policies
    20260724140000_hiring_retention_cron.sql  ← new: pg_cron schedule for purge-stale-candidates
  functions/
    _shared/
      gmail-auth.ts                           ← new: extracted from sync-gmail-tickets/index.ts
    sync-gmail-tickets/
      index.ts                                ← modified: use _shared/gmail-auth.ts instead of inline token fn
    sync-hiring-applications/
      index.ts                                ← new: Indeed stub-row creation
      index.test.ts                           ← new
    parse-resume-batch/
      index.ts                                ← new: Claude resume extraction + JD auto-score
      index.test.ts                           ← new
    suggest-screening-rubric/
      index.ts                                ← new: Claude JD → rubric dimensions
      index.test.ts                           ← new
    purge-stale-candidates/
      index.ts                                ← new: 1-year retention purge
      index.test.ts                           ← new
app/
  src/
    lib/
      hiring.ts                               ← new: types, hooks, mutations
      hiring.test.ts                          ← new
      permissions.ts                          ← modified: add 'hiring' Module + posting-scoped check
      permissions.test.ts                     ← modified
    modules/
      Hiring/
        index.tsx                             ← new: root, tab bar, route-level RBAC guard content
        PostingsTab.tsx                        ← new
        ApplicantsTab.tsx                      ← new
        ResumeUploadPanel.tsx                  ← new
        InterviewsTab.tsx                      ← new
        Hiring.module.css                      ← new
      GlobalNav (existing component)           ← modified: add Hiring nav entry, hidden unless canView
    App.tsx                                    ← modified: add /hiring route with guard
```

---

## Task 1: Migration — core Hiring schema

**Files:**
- Create: `supabase/migrations/20260724130000_hiring_schema.sql`

**Interfaces:**
- Produces: `public.job_postings`, `public.candidates`, `public.posting_interviewers`, `public.interviews` tables; `public.can_view_posting(p_posting_id uuid) returns boolean`; `public.activity_entity_type` enum gains `'candidate'` and `'job_posting'`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260724130000_hiring_schema.sql
--
-- Hiring module core schema (PRD §4.15). Four tables behind a shared
-- can_view_posting() RLS helper: leadership (is_finance(), which already
-- means finance-or-admin) sees everything; anyone else needs an explicit
-- posting_interviewers row for that specific posting. All four tables use
-- the same helper so a reviewer added to one posting never sees another.

create table public.job_postings (
  id                uuid        primary key default gen_random_uuid(),
  title             text        not null,
  department        text,
  location          text,
  comp_range        text,
  status            text        not null default 'open'
                      check (status in ('open','on_hold','closed')),
  indeed_url        text,
  linkedin_url      text,
  job_description   text,
  screening_rubric  jsonb       not null default '[]'::jsonb,   -- [{dimension, weight_pct}]
  pipeline_stages   jsonb       not null default '["Applied","Screening","Interview","Offer"]'::jsonb,
  created_by        uuid        references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.candidates (
  id                  uuid        primary key default gen_random_uuid(),
  posting_id          uuid        not null references public.job_postings(id) on delete cascade,
  full_name           text        not null,
  email               text,
  phone               text,
  source              text        not null default 'other'
                        check (source in ('indeed','linkedin','referral','other')),
  resume_url          text,
  ingested_via        text        not null default 'manual_upload'
                        check (ingested_via in ('email_sync','manual_upload')),
  enrichment_status   text        not null default 'resume_attached'
                        check (enrichment_status in ('stub','resume_attached')),
  indeed_relay_email  text,
  indeed_dashboard_url text,
  qualifications_tags text[]     not null default '{}',
  stage_index         int        not null default 0,
  scores              jsonb      not null default '{}'::jsonb,       -- {dimension: score} operator
  suggested_scores    jsonb,                                          -- {dimension: score} Claude
  applied_at          timestamptz not null default now(),
  rejected_at         timestamptz,
  hired_at            timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_candidates_posting on public.candidates (posting_id);
create index idx_candidates_stub_lookup on public.candidates (posting_id, full_name)
  where enrichment_status = 'stub';
create index idx_candidates_rejected_at on public.candidates (rejected_at) where rejected_at is not null;

create table public.posting_interviewers (
  id          uuid        primary key default gen_random_uuid(),
  posting_id  uuid        not null references public.job_postings(id) on delete cascade,
  profile_id  uuid        not null references public.profiles(id) on delete cascade,
  added_by    uuid        references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (posting_id, profile_id)
);

create table public.interviews (
  id                 uuid        primary key default gen_random_uuid(),
  candidate_id       uuid        not null references public.candidates(id) on delete cascade,
  round_label        text        not null,
  interviewer_id     uuid        references public.profiles(id),
  calendly_event_uri text        unique,
  scheduled_at       timestamptz,
  held_at            timestamptz,
  decision           text        check (decision in ('advance','reject','hold','no_show')),
  decision_notes     text,
  decided_by         uuid        references auth.users(id),
  decided_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index idx_interviews_candidate on public.interviews (candidate_id);

-- ─── Visibility helper ──────────────────────────────────────────────────
-- Leadership (is_finance() already covers finance+admin) sees every
-- posting. Everyone else needs an explicit posting_interviewers row for
-- that specific posting_id — added by whoever schedules them onto it.
create or replace function public.can_view_posting(p_posting_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_finance() or exists (
    select 1 from public.posting_interviewers
    where posting_id = p_posting_id and profile_id = auth.uid()
  );
$$;
grant execute on function public.can_view_posting(uuid) to authenticated;

alter table public.job_postings enable row level security;
alter table public.candidates enable row level security;
alter table public.posting_interviewers enable row level security;
alter table public.interviews enable row level security;

create policy "job_postings_select" on public.job_postings
  for select to authenticated using (public.can_view_posting(id));
create policy "job_postings_insert" on public.job_postings
  for insert to authenticated with check (public.is_finance());
create policy "job_postings_update" on public.job_postings
  for update to authenticated using (public.can_view_posting(id)) with check (public.can_view_posting(id));

create policy "candidates_select" on public.candidates
  for select to authenticated using (public.can_view_posting(posting_id));
-- No client-side insert policy: sync-hiring-applications and
-- parse-resume-batch both write via the service-role client. Operators
-- update existing rows (stage, scores, rejected_at, hired_at) directly.
create policy "candidates_update" on public.candidates
  for update to authenticated
  using (public.can_view_posting(posting_id))
  with check (public.can_view_posting(posting_id));

create policy "posting_interviewers_select" on public.posting_interviewers
  for select to authenticated using (public.can_view_posting(posting_id));
create policy "posting_interviewers_insert" on public.posting_interviewers
  for insert to authenticated with check (public.is_finance());
create policy "posting_interviewers_delete" on public.posting_interviewers
  for delete to authenticated using (public.is_finance());

create policy "interviews_select" on public.interviews
  for select to authenticated using (
    public.can_view_posting((select posting_id from public.candidates where id = candidate_id))
  );
create policy "interviews_insert" on public.interviews
  for insert to authenticated with check (
    public.can_view_posting((select posting_id from public.candidates where id = candidate_id))
  );
create policy "interviews_update" on public.interviews
  for update to authenticated
  using (public.can_view_posting((select posting_id from public.candidates where id = candidate_id)))
  with check (public.can_view_posting((select posting_id from public.candidates where id = candidate_id)));

alter publication supabase_realtime add table public.job_postings;
alter publication supabase_realtime add table public.candidates;
alter publication supabase_realtime add table public.interviews;

-- Extend the shared activity_log entity-type enum (pattern established by
-- the Products module's 20260717120000_product_issues.sql migration).
alter type public.activity_entity_type add value 'candidate';
alter type public.activity_entity_type add value 'job_posting';

-- updated_at triggers, mirroring 20260512100000_service_module_schema.sql's
-- touch_lifecycle_updated_at pattern (one shared function, reused).
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger job_postings_touch before update on public.job_postings
  for each row execute function public.touch_updated_at();
create trigger candidates_touch before update on public.candidates
  for each row execute function public.touch_updated_at();
```

- [ ] **Step 2: Apply the migration**

```bash
cd app
./node_modules/.bin/supabase db push
```

Expected: `Applying migration 20260724130000_hiring_schema.sql... ✓`

- [ ] **Step 3: Verify RLS helper works**

```bash
./node_modules/.bin/supabase db execute --sql \
  "select proname from pg_proc where proname = 'can_view_posting';"
```

Expected: one row, `can_view_posting`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260724130000_hiring_schema.sql
git commit -m "feat(hiring): add job_postings, candidates, posting_interviewers, interviews schema + RLS"
```

---

## Task 2: Migration — resume storage bucket

**Files:**
- Create: `supabase/migrations/20260724130100_hiring_resumes_bucket.sql`

**Interfaces:**
- Produces: private `hiring-resumes` Storage bucket + RLS policies

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260724130100_hiring_resumes_bucket.sql
--
-- hiring-resumes bucket for uploaded candidate resumes. Private (no public
-- read); the app reads via signed URLs. Mirrors claim-photos bucket
-- (20260622120100) but authenticated-write only — resumes never arrive
-- from an anonymous/public form the way shipping-damage claim photos do.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hiring-resumes',
  'hiring-resumes',
  false,
  10485760, -- 10 MB
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "hiring_resumes_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'hiring-resumes');

create policy "hiring_resumes_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'hiring-resumes');
```

- [ ] **Step 2: Apply and verify**

```bash
cd app
./node_modules/.bin/supabase db push
./node_modules/.bin/supabase db execute --sql \
  "select id, public, file_size_limit from storage.buckets where id = 'hiring-resumes';"
```

Expected: one row, `public=false`, `file_size_limit=10485760`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260724130100_hiring_resumes_bucket.sql
git commit -m "feat(hiring): add private hiring-resumes storage bucket"
```

---

## Task 3: lib/hiring.ts — types, hooks, mutations

**Files:**
- Create: `app/src/lib/hiring.ts`
- Create: `app/src/lib/hiring.test.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`, tables from Task 1
- Produces:
  - `type JobPosting`, `type Candidate`, `type Interview`, `type InternalProfile`
  - `useJobPostings(): { postings: JobPosting[]; loading: boolean }`
  - `useCandidates(postingId: string | null): { candidates: Candidate[]; loading: boolean }`
  - `useInterviews(candidateId: string): { interviews: Interview[]; loading: boolean }`
  - `createJobPosting(input: {title: string; department?: string; location?: string; comp_range?: string; indeed_url?: string; linkedin_url?: string; job_description?: string}): Promise<JobPosting>`
  - `updatePostingRubric(postingId: string, rubric: {dimension:string; weight_pct:number}[]): Promise<void>`
  - `addPostingInterviewer(postingId: string, profileId: string): Promise<void>`
  - `searchInternalProfiles(nameQuery: string): Promise<InternalProfile[]>` — searches `profiles.display_name`; `profiles` has no `email` column (email lives on `auth.users`, not exposed via the client-side query surface)
  - `getCurrentUserId(): Promise<string | null>`
  - `updateCandidateStage(candidateId: string, stageIndex: number): Promise<void>`
  - `recordCandidateScore(candidateId: string, scores: Record<string, number>): Promise<void>`
  - `rejectCandidate(candidateId: string): Promise<void>`
  - `hireCandidate(candidateId: string): Promise<void>`
  - `createInterview(input: {candidateId: string; roundLabel: string; interviewerId: string; calendlyUrl?: string}): Promise<Interview>`
  - `recordInterviewDecision(interviewId: string, decision: Interview['decision'], notes: string): Promise<void>`
  - `suggestScreeningRubric(jobDescription: string): Promise<RubricDimension[]>`
  - `uploadAndScoreResume(input: {postingId: string; file: File; source: CandidateSource}): Promise<ParseResumeResult>`

Why `createJobPosting`/`addPostingInterviewer`/`searchInternalProfiles` are here: without them, nothing in the plan ever creates a posting or assigns an interviewer, which would make the `can_view_posting()` restricted-visibility path (Task 1) unreachable for anyone but leadership — dead code, not a deferred nice-to-have. `getCurrentUserId()`, `suggestScreeningRubric()`, and `uploadAndScoreResume()` exist so Tasks 10-12's UI never import `supabase` directly (Global Constraint) — they wrap `supabase.functions.invoke()` and the storage upload the same way `lib/products.ts:sendIssueChatMessage()` already wraps `product-issue-chat` in this codebase.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/lib/hiring.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useJobPostings, useCandidates, useInterviews,
  createJobPosting, addPostingInterviewer, searchInternalProfiles, getCurrentUserId,
  updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  createInterview, recordInterviewDecision, updatePostingRubric,
  suggestScreeningRubric, uploadAndScoreResume,
} from './hiring';

const {
  mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockUpdate, mockInsert, mockSingle, mockEq,
  mockGetUser, mockInvoke, mockStorageUpload,
} = vi.hoisted(() => {
    const mockResolve = vi.fn();
    const mockUnsubscribe = vi.fn();
    const mockOn = vi.fn().mockReturnThis();
    const mockSubscribe = vi.fn().mockReturnThis();
    const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
    const mockSingle = vi.fn();
    const mockEq = vi.fn(() => ({ single: mockSingle }));
    const mockUpdate = vi.fn(() => ({ eq: mockEq }));
    const mockInsert = vi.fn(() => ({ select: () => ({ single: mockSingle }) }));
    const mockGetUser = vi.fn();
    const mockInvoke = vi.fn();
    const mockStorageUpload = vi.fn();
    return {
      mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockUpdate, mockInsert, mockSingle, mockEq,
      mockGetUser, mockInvoke, mockStorageUpload,
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
      storage: { from: () => ({ upload: mockStorageUpload }) },
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
    // No mockResolve queuing here — addPostingInterviewer's insert() resolves
    // via a plain object (mockInsert's return value), not the shared builder
    // thenable, so a queued mockResolve value here is never consumed and
    // leaks into the NEXT test's queue instead (caught in Task 3's review —
    // this caused a false failure in searchInternalProfiles).
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
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd app
npx vitest run src/lib/hiring.test.ts
```

Expected: `Cannot find module './hiring'`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/lib/hiring.ts
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
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/lib/hiring.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/hiring.ts app/src/lib/hiring.test.ts
git commit -m "feat(hiring): add lib/hiring.ts — types, hooks, mutations"
```

---

## Task 4: Extract shared Gmail auth helper

**Files:**
- Create: `supabase/functions/_shared/gmail-auth.ts`
- Modify: `supabase/functions/sync-gmail-tickets/index.ts:19,575-598` (remove inline token function, import shared one)

**Interfaces:**
- Produces: `getGmailAccessToken(saKey: ServiceAccountKey, delegatedSubject: string, scopes: string): Promise<string>`, `type ServiceAccountKey`

Why: `sync-hiring-applications` (Task 5) needs to mint the exact same kind of domain-wide-delegation token `sync-gmail-tickets` already does, to read the same `support@virgohome.io` mailbox. Rather than duplicate the JWT-signing logic a second time, extract it — mirroring the precedent already set when `google-calendar.ts` was extracted out of `sync-calendly-events` for the same reason (see that file's own header comment).

- [ ] **Step 1: Write the shared module**

```typescript
// supabase/functions/_shared/gmail-auth.ts
//
// Extracted from sync-gmail-tickets/index.ts so a second consumer
// (sync-hiring-applications) doesn't duplicate the JWT-bearer token mint.
// Mirrors the precedent set by _shared/google-calendar.ts (originally
// inlined in sync-calendly-events, extracted for the same reason).

import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

export async function getGmailAccessToken(
  saKey: ServiceAccountKey, delegatedSubject: string, scopes: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(saKey.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: scopes })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saKey.client_email)
    .setSubject(delegatedSubject)
    .setAudience(saKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token');
  return json.access_token;
}
```

- [ ] **Step 2: Update sync-gmail-tickets to use the shared helper**

In `supabase/functions/sync-gmail-tickets/index.ts`:

Replace the import line:
```typescript
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';
```
with:
```typescript
import { getGmailAccessToken, type ServiceAccountKey } from '../_shared/gmail-auth.ts';
```

Delete the local `type ServiceAccountKey = {...}` block (now imported) and the local `async function getAccessToken(saKey, delegatedSubject)` function body (lines 575-598 per the file read during planning). Replace every call site `getAccessToken(saKey, mailbox)` with `getGmailAccessToken(saKey, mailbox, SCOPES)` (the module already defines `const SCOPES = '...'` — pass it explicitly now that the shared helper takes scopes as a parameter instead of a closed-over constant).

- [ ] **Step 3: Run existing sync-gmail-tickets tests to confirm no regression**

```bash
deno test supabase/functions/sync-gmail-tickets/index.test.ts --allow-net
```

Expected: same pass count as before this change (this refactor changes no behavior, only where the token-minting code lives).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/gmail-auth.ts supabase/functions/sync-gmail-tickets/index.ts
git commit -m "refactor(gmail): extract token minting into _shared/gmail-auth.ts for reuse by sync-hiring-applications"
```

---

## Task 5: Edge function — sync-hiring-applications

**Files:**
- Create: `supabase/functions/sync-hiring-applications/index.ts`
- Create: `supabase/functions/sync-hiring-applications/index.test.ts`

**Interfaces:**
- Consumes: `_shared/auth.ts:authenticate()`, `_shared/cors.ts:corsHeaders`, `_shared/gmail-auth.ts:getGmailAccessToken` (Task 4), `GOOGLE_SERVICE_ACCOUNT_KEY` + `GMAIL_DELEGATED_MAILBOXES` env (already set for `sync-gmail-tickets`), `public.job_postings` / `public.candidates` (Task 1)
- Produces: `parseIndeedNotification(subject: string, from: string, plaintextBody: string): IndeedApplication | null` (exported for testing); stub rows in `candidates`

- [ ] **Step 1: Write the failing tests**

```typescript
// supabase/functions/sync-hiring-applications/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseIndeedNotification } from './index.ts';

const REAL_SUBJECT = '[Action required] New application for Operations & Fulfillment Specialist, Markham, ON L3R 9Z7';
const REAL_FROM = 'conversation-jenivansivakumaru-9pqzi@indeedemail.com';
const REAL_BODY = `Jenivan Sivakumaru applied to the Operations & Fulfillment Specialist position posted on Indeed. You will find their information below and resume attached (if one was provided).

https://account.indeed.com/o/myaccess/switch/confirm?employerId=8c0b8fb9ae554408dac0e11bfd3c25f6&continue=https%3A%2F%2Femployers.indeed.com%2Fcandidates%2Fview%3Fid%3Da2d8364fa918%26refUid%3D1jqc7qi7ckdcg800

Name: Jenivan Sivakumaru
Email: conversation-jenivansivakumaru-9pqzi@indeedemail.com`;

Deno.test('parseIndeedNotification: extracts name, job title, relay email, dashboard link from a real per-candidate email', () => {
  const result = parseIndeedNotification(REAL_SUBJECT, REAL_FROM, REAL_BODY);
  assertEquals(result?.candidateName, 'Jenivan Sivakumaru');
  assertEquals(result?.jobTitle, 'Operations & Fulfillment Specialist');
  assertEquals(result?.relayEmail, 'conversation-jenivansivakumaru-9pqzi@indeedemail.com');
  assertEquals(result?.dashboardUrl?.includes('employers.indeed.com/candidates/view'), true);
});

Deno.test('parseIndeedNotification: returns null for non-application senders (marketing)', () => {
  const result = parseIndeedNotification(
    'Upcoming webinar — Hiring smarter: What strategy works best?',
    'learn@mc.indeed.com',
    'Join our webinar...',
  );
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: returns null for non-indeed senders entirely', () => {
  const result = parseIndeedNotification(REAL_SUBJECT, 'someone@gmail.com', REAL_BODY);
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: bundled digest email returns null (needs the See-all-candidates flow, not per-candidate parsing)', () => {
  // employers-noreply@indeed.com bundled emails ("X and N others applied")
  // don't carry a single candidate name/dashboard-link pair cleanly — V1
  // intentionally skips them and relies on the per-candidate conversation-*
  // emails, which fire for the same applicants individually in practice.
  const result = parseIndeedNotification(
    REAL_SUBJECT, 'employers-noreply@indeed.com', 'Junhyuk (James) Park and 2 others applied',
  );
  assertEquals(result, null);
});

Deno.test('parseIndeedNotification: extracts job title cleanly when location has a comma', () => {
  const result = parseIndeedNotification(
    '[Action required] New application for Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op, Markham, ON L3R 9Z7',
    'conversation-tylerchin-58ifd@indeedemail.com',
    'Tyler Chin applied to the Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op position posted on Indeed.\n\nhttps://employers.indeed.com/candidates/view?id=abc123\n\nName: Tyler Chin\nEmail: conversation-tylerchin-58ifd@indeedemail.com',
  );
  assertEquals(result?.candidateName, 'Tyler Chin');
  assertEquals(result?.jobTitle, 'Product Engineering Co-op VCycene Inc. | Markham, ON (In-Person) | 8-Month Co-op');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
deno test supabase/functions/sync-hiring-applications/index.test.ts 2>&1 | head -10
```

Expected: `error: Module not found` — `index.ts` doesn't exist yet.

- [ ] **Step 3: Write the edge function**

```typescript
// supabase/functions/sync-hiring-applications/index.ts
//
// Creates lightweight "stub" candidate rows from Indeed's real
// notification-email format on the shared support@virgohome.io mailbox
// (same mailbox sync-gmail-tickets already reads). Verified against real
// inbox data 2026-07-24: Indeed's per-candidate emails come from
// conversation-{name}-{id}@indeedemail.com with subject
// "[Action required] New application for {title}, {location}" — but never
// actually attach the resume (only a "View resume" link to Indeed's
// login-gated dashboard), and the sender is an Indeed relay address, not
// the candidate's real email. Real contact info + the resume file itself
// still arrive via the parse-resume-batch upload path (primary path, not
// a fallback) — see docs/PRD-2026-06-06.md §4.15.
//
// Sender filter is mutually exclusive with sync-gmail-tickets's own
// filter (GMAIL_QUERY excludes indeedemail.com/indeed.com there) so an
// applicant notification can never be double-processed as a support
// ticket.
//
// Bundled digest emails (employers-noreply@indeed.com, "X and N others
// applied") are intentionally skipped in V1 — see the test file for why.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { getGmailAccessToken, type ServiceAccountKey } from '../_shared/gmail-auth.ts';

const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const HIRING_MAILBOX = 'support@virgohome.io';
const INDEED_SUBJECT_PREFIX = '[Action required] New application for ';

export type IndeedApplication = {
  candidateName: string;
  jobTitle: string;
  relayEmail: string;
  dashboardUrl: string | null;
};

/** Parses a single Indeed per-candidate application email. Returns null
 *  for anything that isn't a real per-candidate application notification
 *  (marketing mail, non-Indeed senders, or bundled digest emails — see
 *  index.test.ts for the exact cases this excludes and why). Exported for
 *  unit testing without needing a live Gmail connection. */
export function parseIndeedNotification(
  subject: string, from: string, plaintextBody: string,
): IndeedApplication | null {
  if (!from.includes('@indeedemail.com')) return null; // excludes employers-noreply@, learn@mc., etc.
  if (!subject.startsWith(INDEED_SUBJECT_PREFIX)) return null;

  // Indeed's subject always ends in exactly two trailing ", "-segments —
  // "City" + "Province Postal" — even when the job title itself contains
  // internal commas (e.g. "... | Markham, ON (In-Person) | ..."). A naive
  // lastIndexOf(', ') only strips the LAST segment, leaving the city glued
  // to the title (caught in Task 5's review: real fixture "Operations &
  // Fulfillment Specialist, Markham, ON L3R 9Z7" came back as "...
  // Specialist, Markham" instead of "... Specialist"). Splitting and
  // dropping exactly the last two segments generalizes to any number of
  // internal title commas, provided the 2-segment location invariant holds.
  const afterPrefix = subject.slice(INDEED_SUBJECT_PREFIX.length);
  const parts = afterPrefix.split(', ');
  const jobTitle = parts.length > 2 ? parts.slice(0, -2).join(', ') : afterPrefix.trim();
  if (!jobTitle) return null;

  const nameMatch = plaintextBody.match(/^([^\n]+?) applied to /m);
  const candidateName = nameMatch?.[1]?.trim();
  if (!candidateName) return null;

  // Indeed wraps the dashboard link in a session-switch redirect with the
  // real target percent-encoded inside a `continue=` param (e.g.
  // `...&continue=https%3A%2F%2Femployers.indeed.com%2Fcandidates%2Fview...`).
  // A literal regex for `employers.indeed.com/candidates/view` never matches
  // percent-encoded slashes, so it must be decoded first (caught in Task 5's
  // review — confirmed against the real fixture). decodeURIComponent on the
  // whole wrapper URL is a no-op for plain, unencoded links, so this doesn't
  // change behavior for those.
  const urlToken = plaintextBody.match(/https:\/\/[^\s]+/)?.[0];
  const decoded = urlToken ? decodeURIComponent(urlToken) : '';
  const dashboardIdx = decoded.indexOf('https://employers.indeed.com/candidates/view');
  const dashboardUrl = dashboardIdx === -1 ? null : decoded.slice(dashboardIdx);

  return {
    candidateName,
    jobTitle,
    relayEmail: from,
    dashboardUrl,
  };
}

type GmailMessage = {
  id: string;
  payload?: { headers?: { name: string; value: string }[] };
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const saKeyB64    = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  if (!supabaseUrl || !serviceKey || !saKeyB64) {
    return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_SERVICE_ACCOUNT_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return json({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  const saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
  const token = await getGmailAccessToken(saKey, HIRING_MAILBOX, GMAIL_SCOPES);

  const { data: postings } = await admin.from('job_postings').select('id, title').eq('status', 'open');
  const postingsByTitle = new Map((postings ?? []).map(p => [p.title.trim(), p.id as string]));

  const query = encodeURIComponent('from:indeedemail.com newer_than:7d');
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${HIRING_MAILBOX}/messages?q=${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) return json({ error: `Gmail list ${listRes.status}: ${await listRes.text()}` }, 500);
  const { messages } = await listRes.json() as { messages?: { id: string }[] };

  let created = 0, skipped = 0;
  const errors: string[] = [];

  for (const m of messages ?? []) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/${HIRING_MAILBOX}/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) { errors.push(`${m.id}: fetch ${msgRes.status}`); continue; }
      const msg = await msgRes.json() as GmailMessage & { snippet?: string; payload?: { body?: { data?: string }; parts?: { mimeType?: string; body?: { data?: string } }[] } };

      const headers = msg.payload?.headers ?? [];
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? '';
      const plainPart = msg.payload?.parts?.find(p => p.mimeType === 'text/plain')?.body?.data
        ?? msg.payload?.body?.data;
      const body = plainPart ? decodeBase64Url(plainPart) : (msg.snippet ?? '');

      const parsed = parseIndeedNotification(subject, from, body);
      if (!parsed) { skipped++; continue; }

      const postingId = postingsByTitle.get(parsed.jobTitle);
      if (!postingId) { skipped++; continue; } // no open posting matches this title — nothing to attach the stub to

      const { data: existing } = await admin
        .from('candidates')
        .select('id')
        .eq('posting_id', postingId)
        .ilike('full_name', parsed.candidateName)
        .maybeSingle();
      if (existing) { skipped++; continue; } // already have a stub or full record for this person on this posting

      const { error: insertErr } = await admin.from('candidates').insert({
        posting_id: postingId,
        full_name: parsed.candidateName,
        source: 'indeed',
        ingested_via: 'email_sync',
        enrichment_status: 'stub',
        indeed_relay_email: parsed.relayEmail,
        indeed_dashboard_url: parsed.dashboardUrl,
      });
      if (insertErr) { errors.push(`${m.id}: insert ${insertErr.message}`); continue; }
      created++;
    } catch (e) {
      errors.push(`${m.id}: ${(e as Error).message}`);
    }
  }

  return json({ created, skipped, errors }, 200);
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  try { return atob(b64); } catch { return ''; }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
```

- [ ] **Step 4: Run the unit tests to confirm they pass**

```bash
deno test supabase/functions/sync-hiring-applications/index.test.ts --allow-net
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-hiring-applications/
git commit -m "feat(hiring): add sync-hiring-applications edge function — Indeed stub-row creation"
```

- [ ] **Step 6: Deploy and schedule**

```bash
cd app
./node_modules/.bin/supabase functions deploy sync-hiring-applications
./node_modules/.bin/supabase db execute --sql "
select cron.schedule(
  'sync-hiring-applications-hourly',
  '0 * * * *',
  \$\$ select public.invoke_edge_function('sync-hiring-applications'); \$\$
);"
```

Expected: `Deployed Function sync-hiring-applications`, then one cron.job row.

---

## Task 6: Edge function — parse-resume-batch

**Files:**
- Create: `supabase/functions/parse-resume-batch/index.ts`
- Create: `supabase/functions/parse-resume-batch/index.test.ts`

**Interfaces:**
- Consumes: `_shared/auth.ts:authenticate()`, `ANTHROPIC_API_KEY` env, `public.candidates` / `public.job_postings` (Task 1), `hiring-resumes` storage bucket (Task 2)
- Produces: `buildScoringPrompt(jd: string, rubric: RubricDimension[]): string` (exported for testing), `matchExistingStub(candidates: {id:string; full_name:string}[], extractedName: string): string | null` (exported for testing); HTTP contract `{ candidate_id, full_name, email, phone, suggested_scores, enrichment_status }`

- [ ] **Step 1: Write the failing tests**

```typescript
// supabase/functions/parse-resume-batch/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScoringPrompt, matchExistingStub } from './index.ts';

Deno.test('buildScoringPrompt: includes the JD text and every rubric dimension', () => {
  const prompt = buildScoringPrompt(
    'We need an Operations & Fulfillment Specialist to run our Markham warehouse...',
    [{ dimension: 'Logistics experience', weight_pct: 50 }, { dimension: 'Communication', weight_pct: 50 }],
  );
  assertEquals(prompt.includes('Operations & Fulfillment Specialist'), true);
  assertEquals(prompt.includes('Logistics experience'), true);
  assertEquals(prompt.includes('Communication'), true);
});

Deno.test('matchExistingStub: matches on case-insensitive exact name', () => {
  const candidates = [{ id: 'c1', full_name: 'Jenivan Sivakumaru' }, { id: 'c2', full_name: 'Roshan Shaji' }];
  assertEquals(matchExistingStub(candidates, 'jenivan sivakumaru'), 'c1');
});

Deno.test('matchExistingStub: returns null when no name matches', () => {
  const candidates = [{ id: 'c1', full_name: 'Jenivan Sivakumaru' }];
  assertEquals(matchExistingStub(candidates, 'Someone Else'), null);
});

Deno.test('matchExistingStub: returns null for an empty candidate list', () => {
  assertEquals(matchExistingStub([], 'Anyone'), null);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
deno test supabase/functions/parse-resume-batch/index.test.ts 2>&1 | head -10
```

Expected: `error: Module not found`.

- [ ] **Step 3: Write the edge function**

```typescript
// supabase/functions/parse-resume-batch/index.ts
//
// Primary path to a full candidate record (PRD §4.15) — Indeed's
// notification emails never attach the resume (verified against real
// inbox data, see sync-hiring-applications), so this is where the real
// resume file, real contact info, and a JD-grounded auto-score actually
// enter makeLILA. Called once per uploaded file from the Applicants tab's
// batch uploader.
//
// Flow: caller uploads the PDF/DOCX to the hiring-resumes bucket first
// (client-side, via lib/hiring.ts) and passes the resulting storage path
// here. This function downloads it, sends it to Claude as a document
// content block for {name, email, phone} extraction AND a JD-grounded
// rubric score (unconditional — no opt-in toggle, per product decision),
// then either enriches a matching stub row (name match within the same
// posting) or inserts a brand-new full record.
//
// Auth: requires a user JWT (rejects cron-secret callers) — this is
// always triggered by a team member's upload action, never a schedule.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export type RubricDimension = { dimension: string; weight_pct: number };

export type ParseResumeInput = {
  posting_id: string;
  storage_path: string;   // path within the hiring-resumes bucket
  mime_type: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  source: 'indeed' | 'linkedin' | 'referral' | 'other';
};

type ExtractedResume = {
  full_name: string;
  email: string | null;
  phone: string | null;
  suggested_scores: Record<string, number>;
};

/** Builds the prompt sent to Claude alongside the resume document. Grounds
 *  the score in the actual JD text (not just rubric dimension labels) per
 *  the product decision to make auto-scoring automatic and JD-driven.
 *  Exported for unit testing without a live Claude call. */
export function buildScoringPrompt(jobDescription: string, rubric: RubricDimension[]): string {
  return `You are screening a resume against a specific job posting for VCycene/LILA Composter.

Job description:
${jobDescription}

Score this candidate against each of the following weighted dimensions, using a 1-5 scale (5 = excellent fit):
${rubric.map(r => `- ${r.dimension} (weight ${r.weight_pct}%)`).join('\n')}

Extract the candidate's real contact info from the resume itself (not any cover-letter boilerplate).

Respond with JSON ONLY, matching exactly:
{
  "full_name": "<candidate's full name as it appears on the resume>",
  "email": "<email found on the resume, or null>",
  "phone": "<phone found on the resume, or null>",
  "suggested_scores": { "<dimension>": <1-5 integer>, ... one entry per dimension listed above }
}`;
}

/** Case-insensitive exact-name match against a posting's existing stub
 *  rows. Exported for unit testing — the real caller passes rows already
 *  scoped to enrichment_status='stub' for the target posting_id. */
export function matchExistingStub(
  candidates: { id: string; full_name: string }[], extractedName: string,
): string | null {
  const target = extractedName.trim().toLowerCase();
  const match = candidates.find(c => c.full_name.trim().toLowerCase() === target);
  return match?.id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not configured. Set it via supabase secrets set.' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const input = await req.json().catch(() => null) as ParseResumeInput | null;
  if (!input?.posting_id || !input.storage_path || !input.mime_type) {
    return json({ error: 'posting_id, storage_path, and mime_type are required' }, 400);
  }

  const { data: posting, error: postingErr } = await admin
    .from('job_postings')
    .select('job_description, screening_rubric')
    .eq('id', input.posting_id)
    .single();
  if (postingErr || !posting) return json({ error: `Posting not found: ${postingErr?.message}` }, 404);
  if (!posting.job_description) {
    return json({ error: 'This posting has no job_description set — add one before scoring resumes against it.' }, 400);
  }

  const { data: fileBlob, error: dlErr } = await admin.storage.from('hiring-resumes').download(input.storage_path);
  if (dlErr || !fileBlob) return json({ error: `Resume download failed: ${dlErr?.message}` }, 500);
  const fileB64 = arrayBufferToBase64(await fileBlob.arrayBuffer());

  const prompt = buildScoringPrompt(posting.job_description, posting.screening_rubric as RubricDimension[]);

  const claudeRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: input.mime_type, data: fileB64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!claudeRes.ok) return json({ error: `Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}` }, 502);
  const claudeJson = await claudeRes.json() as { content?: { type: string; text?: string }[] };
  const textBlock = claudeJson.content?.find(c => c.type === 'text')?.text ?? '';

  let extracted: ExtractedResume;
  try {
    extracted = JSON.parse(textBlock.trim().replace(/^```json\n?|```$/g, '')) as ExtractedResume;
  } catch {
    return json({ error: 'Claude did not return valid JSON', raw: textBlock.slice(0, 300) }, 502);
  }
  if (!extracted.full_name) return json({ error: 'Claude did not extract a full_name from this resume' }, 502);

  const { data: stubs } = await admin
    .from('candidates')
    .select('id, full_name')
    .eq('posting_id', input.posting_id)
    .eq('enrichment_status', 'stub');
  const matchedId = matchExistingStub(stubs ?? [], extracted.full_name);

  // hiring-resumes is a private bucket (Task 2) — getPublicUrl() would
  // silently produce a dead link (caught in Task 6's review). Store the raw
  // storage path instead; resolving it to a viewable link via
  // createSignedUrl() belongs at READ time (Task 11's Applicants tab UI),
  // not here, since signed URLs expire and this value needs to stay valid
  // indefinitely.
  const resumeUrl = input.storage_path;

  if (matchedId) {
    const { error: updateErr } = await admin.from('candidates').update({
      full_name: extracted.full_name,
      email: extracted.email,
      phone: extracted.phone,
      resume_url: resumeUrl,
      enrichment_status: 'resume_attached',
      suggested_scores: extracted.suggested_scores,
    }).eq('id', matchedId);
    if (updateErr) return json({ error: `Enrich failed: ${updateErr.message}` }, 500);

    await admin.from('activity_log').insert({
      user_id: caller.user_id, type: 'candidate_resume_enriched', entity: extracted.full_name,
      entity_type: 'candidate', entity_id: matchedId,
    });
    return json({ candidate_id: matchedId, ...extracted, enrichment_status: 'resume_attached' }, 200);
  }

  const { data: inserted, error: insertErr } = await admin.from('candidates').insert({
    posting_id: input.posting_id,
    full_name: extracted.full_name,
    email: extracted.email,
    phone: extracted.phone,
    source: input.source,
    resume_url: resumeUrl,
    ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached',
    suggested_scores: extracted.suggested_scores,
  }).select('id').single();
  if (insertErr || !inserted) return json({ error: `Insert failed: ${insertErr?.message}` }, 500);

  await admin.from('activity_log').insert({
    user_id: caller.user_id, type: 'candidate_uploaded', entity: extracted.full_name,
    entity_type: 'candidate', entity_id: inserted.id,
  });
  return json({ candidate_id: inserted.id, ...extracted, enrichment_status: 'resume_attached' }, 200);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
```

- [ ] **Step 4: Run the unit tests to confirm they pass**

```bash
deno test supabase/functions/parse-resume-batch/index.test.ts --allow-net
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/parse-resume-batch/
git commit -m "feat(hiring): add parse-resume-batch edge function — Claude resume extraction + JD-grounded auto-score"
```

- [ ] **Step 6: Deploy**

```bash
cd app
./node_modules/.bin/supabase functions deploy parse-resume-batch
```

Expected: `Deployed Function parse-resume-batch`.

---

## Task 7: Edge function — suggest-screening-rubric

**Files:**
- Create: `supabase/functions/suggest-screening-rubric/index.ts`
- Create: `supabase/functions/suggest-screening-rubric/index.test.ts`

**Interfaces:**
- Consumes: `_shared/auth.ts:authenticate()`, `ANTHROPIC_API_KEY`
- Produces: `validateRubric(rubric: unknown): RubricDimension[] | null` (exported for testing); HTTP contract `{ rubric: RubricDimension[] }`

- [ ] **Step 1: Write the failing tests**

```typescript
// supabase/functions/suggest-screening-rubric/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateRubric } from './index.ts';

Deno.test('validateRubric: accepts a well-formed rubric summing to 100', () => {
  const result = validateRubric([
    { dimension: 'Logistics experience', weight_pct: 50 },
    { dimension: 'Communication', weight_pct: 50 },
  ]);
  assertEquals(result?.length, 2);
});

Deno.test('validateRubric: rejects weights that do not sum to 100', () => {
  const result = validateRubric([{ dimension: 'A', weight_pct: 40 }, { dimension: 'B', weight_pct: 40 }]);
  assertEquals(result, null);
});

Deno.test('validateRubric: rejects a non-array payload', () => {
  assertEquals(validateRubric({ dimension: 'A' }), null);
  assertEquals(validateRubric(null), null);
});

Deno.test('validateRubric: rejects an entry missing a dimension label', () => {
  const result = validateRubric([{ dimension: '', weight_pct: 100 }]);
  assertEquals(result, null);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
deno test supabase/functions/suggest-screening-rubric/index.test.ts 2>&1 | head -10
```

Expected: `error: Module not found`.

- [ ] **Step 3: Write the edge function**

```typescript
// supabase/functions/suggest-screening-rubric/index.ts
//
// Lets a job posting's rubric be authored from its JD instead of by hand
// (PRD §4.15). Called from the Postings tab's "Suggest from JD" button.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export type RubricDimension = { dimension: string; weight_pct: number };

/** Validates a Claude-proposed rubric: non-empty array, every entry has a
 *  non-empty dimension label and a positive weight, weights sum to 100
 *  (within floating-point tolerance). Exported for unit testing. */
export function validateRubric(rubric: unknown): RubricDimension[] | null {
  if (!Array.isArray(rubric) || rubric.length === 0) return null;
  const parsed: RubricDimension[] = [];
  let total = 0;
  for (const entry of rubric) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.dimension !== 'string' || !e.dimension.trim()) return null;
    if (typeof e.weight_pct !== 'number' || e.weight_pct <= 0) return null;
    parsed.push({ dimension: e.dimension.trim(), weight_pct: e.weight_pct });
    total += e.weight_pct;
  }
  if (Math.abs(total - 100) > 0.5) return null;
  return parsed;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not configured.' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const { job_description } = await req.json().catch(() => ({})) as { job_description?: string };
  if (!job_description?.trim()) return json({ error: 'job_description is required' }, 400);

  const claudeRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Propose 3-5 weighted screening dimensions for this job posting, with weights summing to exactly 100. Respond with JSON ONLY: an array of {"dimension": "...", "weight_pct": <number>}.\n\nJob description:\n${job_description}`,
      }],
    }),
  });
  if (!claudeRes.ok) return json({ error: `Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}` }, 502);
  const claudeJson = await claudeRes.json() as { content?: { type: string; text?: string }[] };
  const textBlock = claudeJson.content?.find(c => c.type === 'text')?.text ?? '';

  let proposed: unknown;
  try { proposed = JSON.parse(textBlock.trim().replace(/^```json\n?|```$/g, '')); }
  catch { return json({ error: 'Claude did not return valid JSON', raw: textBlock.slice(0, 300) }, 502); }

  const rubric = validateRubric(proposed);
  if (!rubric) return json({ error: 'Claude returned an invalid rubric (weights must sum to 100)', raw: proposed }, 502);

  return json({ rubric }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
```

- [ ] **Step 4: Run the unit tests to confirm they pass**

```bash
deno test supabase/functions/suggest-screening-rubric/index.test.ts --allow-net
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit + deploy**

```bash
git add supabase/functions/suggest-screening-rubric/
git commit -m "feat(hiring): add suggest-screening-rubric edge function — Claude JD-to-rubric"
cd app
./node_modules/.bin/supabase functions deploy suggest-screening-rubric
```

---

## Task 8: Edge function — purge-stale-candidates + retention cron

**Files:**
- Create: `supabase/functions/purge-stale-candidates/index.ts`
- Create: `supabase/functions/purge-stale-candidates/index.test.ts`
- Create: `supabase/migrations/20260724140000_hiring_retention_cron.sql`

**Interfaces:**
- Consumes: `_shared/auth.ts:authenticate()`, `public.candidates` (Task 1)
- Produces: `isPastRetention(rejectedAt: string, now: Date): boolean` (exported for testing); purges resume file + nulls PII columns on stale rows

- [ ] **Step 1: Write the failing tests**

```typescript
// supabase/functions/purge-stale-candidates/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isPastRetention } from './index.ts';

Deno.test('isPastRetention: true when rejected_at is more than 1 year before now', () => {
  const now = new Date('2027-08-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:00Z', now), true);
});

Deno.test('isPastRetention: false when rejected_at is less than 1 year before now', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:00Z', now), false);
});

Deno.test('isPastRetention: false exactly at the 1-year boundary minus a second', () => {
  const now = new Date('2027-06-01T00:00:00Z');
  assertEquals(isPastRetention('2026-06-01T00:00:01Z', now), false);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
deno test supabase/functions/purge-stale-candidates/index.test.ts 2>&1 | head -10
```

Expected: `error: Module not found`.

- [ ] **Step 3: Write the edge function**

```typescript
// supabase/functions/purge-stale-candidates/index.ts
//
// Enforces the decided 1-year retention policy for rejected candidates
// (PRD §4.15): purges the resume file from Storage and nulls PII columns
// on candidates rejected more than a year ago. Hired candidates are never
// touched — hired_at exclusion is the whole point. Cron-only, scheduled
// every 24h (see 20260724140000_hiring_retention_cron.sql).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Exported for unit testing without needing Date.now() timing games. */
export function isPastRetention(rejectedAt: string, now: Date): boolean {
  return now.getTime() - new Date(rejectedAt).getTime() > ONE_YEAR_MS;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return json({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  const cutoff = new Date(Date.now() - ONE_YEAR_MS).toISOString();
  const { data: stale, error: fetchErr } = await admin
    .from('candidates')
    .select('id, resume_url')
    .lt('rejected_at', cutoff)
    .is('hired_at', null);
  if (fetchErr) return json({ error: fetchErr.message }, 500);

  let purged = 0;
  const errors: string[] = [];
  for (const row of stale ?? []) {
    try {
      // resume_url holds the raw hiring-resumes storage path directly, not
      // a resolved URL (Task 6 fix — the bucket is private, so no public
      // URL to parse). Remove it from Storage by that path as-is.
      if (row.resume_url) {
        await admin.storage.from('hiring-resumes').remove([row.resume_url]);
      }
      const { error: updateErr } = await admin.from('candidates').update({
        full_name: '[purged]', email: null, phone: null, resume_url: null,
        indeed_relay_email: null,
      }).eq('id', row.id);
      if (updateErr) { errors.push(`${row.id}: ${updateErr.message}`); continue; }
      purged++;
    } catch (e) {
      errors.push(`${row.id}: ${(e as Error).message}`);
    }
  }

  return json({ purged, errors }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
```

- [ ] **Step 4: Run the unit tests to confirm they pass**

```bash
deno test supabase/functions/purge-stale-candidates/index.test.ts --allow-net
```

Expected: all 3 tests pass.

- [ ] **Step 5: Write the cron migration**

```sql
-- supabase/migrations/20260724140000_hiring_retention_cron.sql
-- Runs purge-stale-candidates once daily. Same invoke_edge_function()
-- helper as every other cron job in this repo (patches in both
-- Authorization and X-Cron-Secret headers).

select cron.schedule(
  'purge-stale-candidates-daily',
  '0 3 * * *',   -- 03:00 UTC daily, off-peak
  $$ select public.invoke_edge_function('purge-stale-candidates'); $$
);
```

- [ ] **Step 6: Apply migration, deploy, verify**

```bash
cd app
./node_modules/.bin/supabase db push
./node_modules/.bin/supabase functions deploy purge-stale-candidates
./node_modules/.bin/supabase db execute --sql \
  "select jobname, schedule from cron.job where jobname = 'purge-stale-candidates-daily';"
```

Expected: one row.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/purge-stale-candidates/ supabase/migrations/20260724140000_hiring_retention_cron.sql
git commit -m "feat(hiring): add purge-stale-candidates edge function + daily retention cron"
```

---

## Task 9: lib/permissions.ts — hiring module + posting-scoped visibility

**Files:**
- Modify: `app/src/lib/permissions.ts`
- Modify: `app/src/lib/permissions.test.ts`

**Interfaces:**
- Modifies: `Module` type (adds `'hiring'`), `RESTRICTED_MODULES` array
- Produces: `canViewPosting(role: Role | null | undefined, isAssignedInterviewer: boolean): boolean`

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/permissions.test.ts` (alongside the existing `canDo`/`canView` tests — read the existing file first to match its exact structure before appending):

```typescript
describe('canViewPosting', () => {
  it('returns true for finance role regardless of assignment', () => {
    expect(canViewPosting('finance', false)).toBe(true);
  });
  it('returns true for admin role regardless of assignment', () => {
    expect(canViewPosting('admin', false)).toBe(true);
  });
  it('returns true for an operator who is an assigned interviewer', () => {
    expect(canViewPosting('operator', true)).toBe(true);
  });
  it('returns false for an operator who is not assigned', () => {
    expect(canViewPosting('operator', false)).toBe(false);
  });
  it('returns false for a null role with no assignment', () => {
    expect(canViewPosting(null, false)).toBe(false);
  });
});

describe('canView hiring module', () => {
  it('is restricted like finance', () => {
    expect(canView('operator', 'hiring')).toBe(false);
    expect(canView('finance', 'hiring')).toBe(true);
    expect(canView('admin', 'hiring')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd app
npx vitest run src/lib/permissions.test.ts
```

Expected: `canViewPosting is not a function` / `hiring` case fails (module-level `canView` currently returns `true` for everything not in `RESTRICTED_MODULES`).

- [ ] **Step 3: Update the implementation**

In `app/src/lib/permissions.ts`, add `'hiring'` to the `Module` type and `RESTRICTED_MODULES` array (both already exist — this is a one-line addition to each), then add the new exported function:

```typescript
export type Module =
  | 'finance'
  | 'hiring'       // restricted to finance + admin, or a posting-assigned interviewer — see canViewPosting()
  | 'orderReview'
  | 'fulfillment'
  | 'build'
  | 'postShipment'
  | 'service'
  | 'stock'
  | 'customers'
  | 'lovely'
  | 'templates'
  | 'activityLog'
  | 'dashboard';

const RESTRICTED_MODULES: Module[] = ['finance', 'hiring'];
```

Then append after the existing `isLeadership()` function:

```typescript
/** Posting-level visibility for Hiring: leadership sees every posting;
 *  anyone else needs to be an explicitly assigned interviewer on THAT
 *  posting (checked server-side via posting_interviewers + the
 *  can_view_posting() RLS helper — this client-side mirror is for
 *  UI gating only, not the security boundary). */
export function canViewPosting(role: Role | null | undefined, isAssignedInterviewer: boolean): boolean {
  if (isLeadership(role)) return true;
  return isAssignedInterviewer;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/lib/permissions.test.ts
```

Expected: all tests pass, including every pre-existing test (no regressions).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/permissions.ts app/src/lib/permissions.test.ts
git commit -m "feat(hiring): add 'hiring' restricted module + canViewPosting() to lib/permissions.ts"
```

---

## Task 10: Postings tab UI

**Files:**
- Create: `app/src/modules/Hiring/PostingsTab.tsx`
- Create: `app/src/modules/Hiring/Hiring.module.css`

**Interfaces:**
- Consumes: `useJobPostings`, `updatePostingRubric`, `createJobPosting`, `addPostingInterviewer`, `searchInternalProfiles`, `suggestScreeningRubric` from `../../lib/hiring` (Task 3)
- Produces: `PostingsTab({ onSelectPosting }: { onSelectPosting: (id: string) => void })` — a React component

- [ ] **Step 1: Write the CSS module**

```css
/* app/src/modules/Hiring/Hiring.module.css */
.empty { padding: 20px; color: var(--ink-3); font-size: 13px; }
.postingsGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.postingCard {
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: 16px; cursor: pointer; background: var(--surface-up);
}
.postingCard:hover { border-color: var(--ink-3); }
.postingTitle { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.postingMeta { font-size: 12px; color: var(--ink-3); margin-bottom: 8px; }
.postingStatus { display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; }
.statusOpen { background: #DCFCE7; color: #166534; }
.statusOnHold { background: #FEF3C7; color: #92400E; }
.statusClosed { background: #F3F4F6; color: #6B7280; }
.rubricRow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rubricInput { flex: 1; padding: 4px 8px; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.weightInput { width: 60px; padding: 4px 8px; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.jdTextarea { width: 100%; min-height: 140px; font-size: 13px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: inherit; }
.suggestButton {
  padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: var(--radius-sm);
  border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer;
}
.suggestButton:disabled { opacity: 0.5; cursor: not-allowed; }
.newPostingForm { border: 1px dashed var(--border); border-radius: var(--radius-lg); padding: 16px; margin-bottom: 16px; }
.newPostingForm input, .newPostingForm textarea {
  display: block; width: 100%; margin-bottom: 8px; padding: 6px 8px;
  font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: inherit;
}
.interviewerWidget { margin-top: 10px; font-size: 12px; }
.interviewerResult { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; }
.interviewerList { font-size: 11px; color: var(--ink-3); margin-top: 4px; }
```

- [ ] **Step 2: Write the component**

```typescript
// app/src/modules/Hiring/PostingsTab.tsx
import { useState } from 'react';
import styles from './Hiring.module.css';
import {
  useJobPostings, updatePostingRubric, createJobPosting, addPostingInterviewer, searchInternalProfiles,
  suggestScreeningRubric, type RubricDimension, type PostingStatus, type InternalProfile,
} from '../../lib/hiring';

const STATUS_CLASS: Record<PostingStatus, string> = {
  open: styles.statusOpen, on_hold: styles.statusOnHold, closed: styles.statusClosed,
};
const STATUS_LABEL: Record<PostingStatus, string> = {
  open: 'Open', on_hold: 'On Hold', closed: 'Closed',
};

export function PostingsTab({ onSelectPosting }: { onSelectPosting: (id: string) => void }) {
  const { postings, loading } = useJobPostings();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  return (
    <div>
      <button onClick={() => setShowNewForm(v => !v)} style={{ marginBottom: 12 }}>
        {showNewForm ? 'Cancel' : '+ New Posting'}
      </button>
      {showNewForm && <NewPostingForm onCreated={() => setShowNewForm(false)} />}

      {loading && <div>Loading postings…</div>}
      {!loading && !postings.length && <div className={styles.empty}>No job postings yet.</div>}

      <div className={styles.postingsGrid}>
        {postings.map(p => (
          <div key={p.id} className={styles.postingCard}>
            <div className={styles.postingTitle} onClick={() => onSelectPosting(p.id)}>{p.title}</div>
            <div className={styles.postingMeta}>{p.department ?? '—'} · {p.location ?? '—'} · {p.comp_range ?? '—'}</div>
            <span className={`${styles.postingStatus} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
            <button
              style={{ marginLeft: 8, fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)' }}
              onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
            >
              {expandedId === p.id ? 'Hide rubric ▲' : 'Edit rubric ▼'}
            </button>
            {expandedId === p.id && (
              <>
                <RubricEditor
                  postingId={p.id}
                  jobDescription={p.job_description}
                  rubric={p.screening_rubric}
                />
                <InterviewerAssignment postingId={p.id} />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewPostingForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [compRange, setCompRange] = useState('');
  const [indeedUrl, setIndeedUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await createJobPosting({
        title: title.trim(),
        department: department.trim() || undefined,
        location: location.trim() || undefined,
        comp_range: compRange.trim() || undefined,
        indeed_url: indeedUrl.trim() || undefined,
        job_description: jobDescription.trim() || undefined,
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.newPostingForm}>
      <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
      <input placeholder="Department" value={department} onChange={e => setDepartment(e.target.value)} />
      <input placeholder="Location" value={location} onChange={e => setLocation(e.target.value)} />
      <input placeholder="Comp range (e.g. $60-70k)" value={compRange} onChange={e => setCompRange(e.target.value)} />
      <input placeholder="Indeed posting URL" value={indeedUrl} onChange={e => setIndeedUrl(e.target.value)} />
      <textarea
        className={styles.jdTextarea}
        placeholder="Job description"
        value={jobDescription}
        onChange={e => setJobDescription(e.target.value)}
      />
      <button onClick={submit} disabled={saving || !title.trim()}>{saving ? 'Creating…' : 'Create posting'}</button>
    </div>
  );
}

function InterviewerAssignment({ postingId }: { postingId: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InternalProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try { setResults(await searchInternalProfiles(query.trim())); }
    finally { setSearching(false); }
  }

  async function assign(profile: InternalProfile) {
    await addPostingInterviewer(postingId, profile.id);
    setAdded(prev => [...prev, profile.display_name]);
    setResults([]);
    setQuery('');
  }

  return (
    <div className={styles.interviewerWidget}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Assign interviewer</div>
      <input placeholder="Search by name…" value={query} onChange={e => setQuery(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }} />
      <button onClick={search} disabled={searching || !query.trim()} style={{ marginLeft: 6 }}>Search</button>
      {results.map(r => (
        <div key={r.id} className={styles.interviewerResult}>
          <span>{r.display_name}</span>
          <button onClick={() => assign(r)}>Add</button>
        </div>
      ))}
      {added.length > 0 && <div className={styles.interviewerList}>Assigned this session: {added.join(', ')}</div>}
    </div>
  );
}

function RubricEditor({ postingId, jobDescription, rubric }: {
  postingId: string; jobDescription: string | null; rubric: RubricDimension[];
}) {
  const [rows, setRows] = useState<RubricDimension[]>(rubric.length ? rubric : [{ dimension: '', weight_pct: 0 }]);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function suggestFromJd() {
    if (!jobDescription?.trim()) return;
    setSuggesting(true);
    try {
      const suggested = await suggestScreeningRubric(jobDescription);
      setRows(suggested);
    } finally {
      setSuggesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try { await updatePostingRubric(postingId, rows.filter(r => r.dimension.trim())); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button className={styles.suggestButton} onClick={suggestFromJd} disabled={suggesting || !jobDescription?.trim()}>
        {suggesting ? 'Suggesting…' : 'Suggest from JD'}
      </button>
      {rows.map((r, i) => (
        <div key={i} className={styles.rubricRow}>
          <input
            className={styles.rubricInput}
            placeholder="Dimension"
            value={r.dimension}
            onChange={e => setRows(prev => prev.map((row, idx) => idx === i ? { ...row, dimension: e.target.value } : row))}
          />
          <input
            className={styles.weightInput}
            type="number"
            placeholder="%"
            value={r.weight_pct || ''}
            onChange={e => setRows(prev => prev.map((row, idx) => idx === i ? { ...row, weight_pct: Number(e.target.value) } : row))}
          />
        </div>
      ))}
      <button onClick={() => setRows(prev => [...prev, { dimension: '', weight_pct: 0 }])}>+ Add dimension</button>
      <button onClick={save} disabled={saving} style={{ marginLeft: 8 }}>{saving ? 'Saving…' : 'Save rubric'}</button>
    </div>
  );
}
```

- [ ] **Step 3: Manual smoke test**

```bash
cd app
npm run dev
```

Navigate to the Hiring module (wired in Task 13). Click "+ New Posting", fill in a title + job description, create it, and confirm it appears in the grid. Open its rubric editor, click "Suggest from JD", confirm the proposed dimensions populate and weights sum sensibly, edit a weight, save, and confirm `job_postings.screening_rubric` updates in the Supabase table editor. Then use "Assign interviewer" to search for and add a real internal profile by name, and confirm a row appears in `posting_interviewers`.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Hiring/PostingsTab.tsx app/src/modules/Hiring/Hiring.module.css
git commit -m "feat(hiring): add Postings tab UI with JD-driven rubric suggestion"
```

---

## Task 11: Applicants tab UI + batch resume upload

**Files:**
- Create: `app/src/modules/Hiring/ApplicantsTab.tsx`
- Create: `app/src/modules/Hiring/ResumeUploadPanel.tsx`
- Modify: `app/src/modules/Hiring/Hiring.module.css`
- Modify: `app/src/lib/hiring.ts` (add `getResumeSignedUrl`)
- Modify: `app/src/lib/hiring.test.ts` (add its test)

**Interfaces:**
- Consumes: `useCandidates`, `updateCandidateStage`, `recordCandidateScore`, `rejectCandidate`, `hireCandidate`, `uploadAndScoreResume` from `../../lib/hiring` (Task 3) — no direct `supabase` import in either component (Global Constraint); `uploadAndScoreResume()` wraps both the storage upload and the `parse-resume-batch` invoke
- Produces: `ApplicantsTab({ postingId, pipelineStages }: { postingId: string; pipelineStages: string[] })`, `ResumeUploadPanel({ postingId, source, onUploaded }: { postingId: string; source: CandidateSource; onUploaded: () => void })`, `getResumeSignedUrl(storagePath: string): Promise<string>` (new addition to `lib/hiring.ts`)

**Why `getResumeSignedUrl` is needed here:** Task 6's review found that `candidates.resume_url` can't be a public URL (the `hiring-resumes` bucket is private) — it stores the raw storage path instead, with signed-URL resolution deferred to read time. This task is that read time: a non-stub candidate's resume needs to actually be viewable, and today's `CandidateCard` has no resume link at all for non-stub candidates. Add this function to `lib/hiring.ts` first:

```typescript
// Append to app/src/lib/hiring.ts
/** Resolves a stored hiring-resumes storage path (candidates.resume_url) to
 *  a time-limited signed URL for viewing. Generated at read time, not
 *  write time, since signed URLs expire — see Task 6's review. */
export async function getResumeSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('hiring-resumes').createSignedUrl(storagePath, 3600);
  if (error || !data) throw error ?? new Error('getResumeSignedUrl: no signed URL returned');
  return data.signedUrl;
}
```

Add the matching test to `app/src/lib/hiring.test.ts` (needs a `mockCreateSignedUrl` added to the hoisted mocks and the `storage.from()` factory alongside the existing `mockStorageUpload`):

```typescript
// Add to the hoisted mocks: const mockCreateSignedUrl = vi.fn();
// Add to storage.from()'s returned object: createSignedUrl: mockCreateSignedUrl
it('getResumeSignedUrl returns the signed URL', async () => {
  mockCreateSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://.../signed?token=abc' }, error: null });
  const url = await getResumeSignedUrl('p1/abc-resume.pdf');
  expect(mockCreateSignedUrl).toHaveBeenCalledWith('p1/abc-resume.pdf', 3600);
  expect(url).toBe('https://.../signed?token=abc');
});
```

- [ ] **Step 1: Append upload-panel styles**

```css
/* append to app/src/modules/Hiring/Hiring.module.css */
.dropzone {
  border: 2px dashed var(--border); border-radius: var(--radius-lg);
  padding: 24px; text-align: center; color: var(--ink-3); font-size: 13px;
  cursor: pointer;
}
.dropzone.dragOver { border-color: var(--accent); background: var(--surface-hover); }
.uploadRow { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
.uploadStatus { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.uploadPending { background: #F3F4F6; color: #6B7280; }
.uploadSuccess { background: #DCFCE7; color: #166534; }
.uploadError { background: #FEE2E2; color: #991B1B; }
.candidateCard { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 10px; }
.stubBadge { font-size: 10px; padding: 2px 8px; border-radius: 999px; background: #FEF3C7; color: #92400E; margin-left: 8px; }
.stageSelect { font-size: 12px; padding: 4px 8px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
.scoreRow { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
```

- [ ] **Step 2: Write ResumeUploadPanel.tsx**

```typescript
// app/src/modules/Hiring/ResumeUploadPanel.tsx
import { useCallback, useState } from 'react';
import styles from './Hiring.module.css';
import { uploadAndScoreResume, type CandidateSource } from '../../lib/hiring';

type UploadState = { file: File; status: 'pending' | 'uploading' | 'scoring' | 'done' | 'error'; message?: string };

export function ResumeUploadPanel({ postingId, source, onUploaded }: {
  postingId: string; source: CandidateSource; onUploaded: () => void;
}) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(async (files: FileList) => {
    const accepted = Array.from(files).filter(f =>
      f.type === 'application/pdf' ||
      f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const entries: UploadState[] = accepted.map(file => ({ file, status: 'pending' }));
    setUploads(prev => [...prev, ...entries]);

    for (const entry of entries) {
      setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'uploading' } : u));
      try {
        setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'scoring' } : u));
        const result = await uploadAndScoreResume({ postingId, file: entry.file, source });
        setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'done', message: result.full_name } : u));
        onUploaded();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'error', message } : u));
      }
    }
  }, [postingId, source, onUploaded]);

  return (
    <div>
      <div
        className={`${styles.dropzone} ${dragOver ? styles.dragOver : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files); }}
        onClick={() => document.getElementById('hiring-resume-input')?.click()}
      >
        Drop resumes here, or click to browse (PDF or DOCX)
        <input
          id="hiring-resume-input" type="file" multiple accept=".pdf,.docx" style={{ display: 'none' }}
          onChange={e => e.target.files && void handleFiles(e.target.files)}
        />
      </div>
      {uploads.map((u, i) => (
        <div key={i} className={styles.uploadRow}>
          <span>{u.file.name}</span>
          <span className={`${styles.uploadStatus} ${
            u.status === 'error' ? styles.uploadError : u.status === 'done' ? styles.uploadSuccess : styles.uploadPending
          }`}>
            {u.status === 'pending' && 'Queued'}
            {u.status === 'uploading' && 'Uploading…'}
            {u.status === 'scoring' && 'Scoring against JD…'}
            {u.status === 'done' && `Filed: ${u.message}`}
            {u.status === 'error' && u.message}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write ApplicantsTab.tsx**

```typescript
// app/src/modules/Hiring/ApplicantsTab.tsx
import { useState } from 'react';
import styles from './Hiring.module.css';
import { ResumeUploadPanel } from './ResumeUploadPanel';
import {
  useCandidates, updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  getResumeSignedUrl, type Candidate,
} from '../../lib/hiring';

export function ApplicantsTab({ postingId, pipelineStages }: { postingId: string; pipelineStages: string[] }) {
  const { candidates, loading } = useCandidates(postingId);

  return (
    <div>
      <ResumeUploadPanel postingId={postingId} source="indeed" onUploaded={() => {}} />
      <h3 style={{ marginTop: 20 }}>Applicants</h3>
      {loading && <div>Loading…</div>}
      {!loading && !candidates.length && <div>No applicants yet.</div>}
      {candidates.map(c => (
        <CandidateCard key={c.id} candidate={c} pipelineStages={pipelineStages} />
      ))}
    </div>
  );
}

function CandidateCard({ candidate, pipelineStages }: { candidate: Candidate; pipelineStages: string[] }) {
  const [scores, setScores] = useState<Record<string, number>>(candidate.scores);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const isStub = candidate.enrichment_status === 'stub';

  async function viewResume() {
    if (!candidate.resume_url) return;
    setResumeError(null);
    try {
      const signedUrl = await getResumeSignedUrl(candidate.resume_url);
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setResumeError('Could not open resume — try again.');
    }
  }

  return (
    <div className={styles.candidateCard}>
      <div>
        <strong>{candidate.full_name}</strong>
        {isStub && <span className={styles.stubBadge}>Stub — no resume yet</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        {candidate.email ?? candidate.indeed_relay_email ?? '—'} · {candidate.phone ?? '—'}
      </div>
      {isStub && candidate.indeed_dashboard_url && (
        <a href={candidate.indeed_dashboard_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
          View on Indeed →
        </a>
      )}
      {!isStub && candidate.resume_url && (
        <div>
          <button onClick={viewResume} style={{ fontSize: 12 }}>View resume</button>
          {resumeError && <span style={{ fontSize: 11, color: 'var(--critical)', marginLeft: 8 }}>{resumeError}</span>}
        </div>
      )}
      {!isStub && (
        <>
          <select
            className={styles.stageSelect}
            value={candidate.stage_index}
            onChange={e => void updateCandidateStage(candidate.id, Number(e.target.value))}
          >
            {pipelineStages.map((s, i) => <option key={i} value={i}>{s}</option>)}
          </select>
          {candidate.suggested_scores && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Claude's suggested scores (edit as needed):</div>
              {Object.entries(candidate.suggested_scores).map(([dim, val]) => (
                <div key={dim} className={styles.scoreRow}>
                  <span>{dim}</span>
                  <input
                    type="number" min={1} max={5} style={{ width: 40 }}
                    value={scores[dim] ?? val}
                    onChange={e => setScores(prev => ({ ...prev, [dim]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <button onClick={() => void recordCandidateScore(candidate.id, scores)}>Save scores</button>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => void hireCandidate(candidate.id)}>Hire</button>
            <button onClick={() => void rejectCandidate(candidate.id)} style={{ marginLeft: 8 }}>Reject</button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Manual smoke test**

```bash
cd app
npm run dev
```

Upload a real PDF resume against a posting with a JD set, confirm the upload panel shows "Scoring against JD…" then "Filed: {name}"; confirm a stub row (if one exists with a matching name on that posting) gets enriched rather than duplicated; confirm the suggested-scores block appears and is editable.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Hiring/ApplicantsTab.tsx app/src/modules/Hiring/ResumeUploadPanel.tsx app/src/modules/Hiring/Hiring.module.css
git commit -m "feat(hiring): add Applicants tab + batch resume upload panel"
```

---

## Task 12: Interviews tab UI

**Files:**
- Create: `app/src/modules/Hiring/InterviewsTab.tsx`

**Interfaces:**
- Consumes: `useInterviews`, `createInterview`, `recordInterviewDecision` from `../../lib/hiring` (Task 3)
- Produces: `InterviewsTab({ candidateId, candidateName }: { candidateId: string; candidateName: string })`

- [ ] **Step 1: Write the component**

```typescript
// app/src/modules/Hiring/InterviewsTab.tsx
import { useState } from 'react';
import styles from './Hiring.module.css';
import { useInterviews, createInterview, recordInterviewDecision, getCurrentUserId, type InterviewDecision } from '../../lib/hiring';

const DECISION_LABEL: Record<InterviewDecision, string> = {
  advance: 'Advance', reject: 'Reject', hold: 'Hold', no_show: 'No-show',
};

export function InterviewsTab({ candidateId, candidateName }: { candidateId: string; candidateName: string }) {
  const { interviews, loading } = useInterviews(candidateId);
  const [roundLabel, setRoundLabel] = useState('');
  const [calendlyUrl, setCalendlyUrl] = useState('');
  const [creating, setCreating] = useState(false);

  async function book() {
    if (!roundLabel.trim()) return;
    setCreating(true);
    try {
      // interviewerId defaults to the current session user — the booking
      // operator is the interviewer unless reassigned later via the DB directly.
      // Goes through lib/hiring's getCurrentUserId() rather than importing
      // supabase directly (components never call supabase directly — AGENTS.md).
      const userId = await getCurrentUserId();
      if (!userId) return;
      await createInterview({ candidateId, roundLabel, interviewerId: userId, calendlyUrl: calendlyUrl || undefined });
      setRoundLabel(''); setCalendlyUrl('');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h4>Interviews — {candidateName}</h4>
      {loading && <div>Loading…</div>}
      {interviews.map(iv => (
        <div key={iv.id} className={styles.candidateCard}>
          <strong>{iv.round_label}</strong>
          {iv.calendly_event_uri && (
            <a href={iv.calendly_event_uri} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8, fontSize: 12 }}>
              Calendly link →
            </a>
          )}
          <div style={{ marginTop: 6 }}>
            {iv.decision ? (
              <span>Decision: <strong>{DECISION_LABEL[iv.decision]}</strong> — {iv.decision_notes}</span>
            ) : (
              <DecisionForm interviewId={iv.id} />
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 16 }}>
        <input placeholder="Round label (e.g. Technical screen)" value={roundLabel} onChange={e => setRoundLabel(e.target.value)} />
        <input placeholder="Calendly event URL (optional)" value={calendlyUrl} onChange={e => setCalendlyUrl(e.target.value)} style={{ marginLeft: 8 }} />
        <button onClick={book} disabled={creating} style={{ marginLeft: 8 }}>Book interview</button>
      </div>
    </div>
  );
}

function DecisionForm({ interviewId }: { interviewId: string }) {
  const [decision, setDecision] = useState<InterviewDecision>('advance');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try { await recordInterviewDecision(interviewId, decision, notes); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <select value={decision} onChange={e => setDecision(e.target.value as InterviewDecision)}>
        {Object.entries(DECISION_LABEL).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
      </select>
      <input placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} style={{ marginLeft: 8 }} />
      <button onClick={submit} disabled={saving} style={{ marginLeft: 8 }}>Submit decision</button>
    </div>
  );
}
```

- [ ] **Step 2: Manual smoke test**

```bash
cd app
npm run dev
```

Book an interview against a full (non-stub) candidate, confirm it appears in the list, submit a decision, confirm it renders read-only afterward.

- [ ] **Step 3: Commit**

```bash
git add app/src/modules/Hiring/InterviewsTab.tsx
git commit -m "feat(hiring): add Interviews tab UI — booking + decision recording"
```

---

## Task 13: Module wiring — root component, nav, route guard

**Files:**
- Create: `app/src/modules/Hiring/index.tsx`
- Modify: `app/src/components/GlobalNav.tsx` (or wherever the nav list is defined — locate via the Finance entry added in the Finance module's own wiring commit)
- Modify: `app/src/App.tsx`

**Interfaces:**
- Consumes: `PostingsTab`, `ApplicantsTab`, `InterviewsTab` (Tasks 10-12), `canView` from `../../lib/permissions` (Task 9)
- Produces: `Hiring()` default export — the module root

- [ ] **Step 1: Write the root component**

```typescript
// app/src/modules/Hiring/index.tsx
import { useState } from 'react';
import styles from './Hiring.module.css';
import { PostingsTab } from './PostingsTab';
import { ApplicantsTab } from './ApplicantsTab';
import { InterviewsTab } from './InterviewsTab';
import { useJobPostings, useCandidates } from '../../lib/hiring';

type View = 'postings' | 'applicants' | 'interviews';

export default function Hiring() {
  const [view, setView] = useState<View>('postings');
  const [selectedPostingId, setSelectedPostingId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const { postings } = useJobPostings();
  const { candidates } = useCandidates(selectedPostingId);

  const selectedPosting = postings.find(p => p.id === selectedPostingId);
  const selectedCandidate = candidates.find(c => c.id === selectedCandidateId);

  return (
    <div className={styles.hiring}>
      <div className={styles.tabBar}>
        <button onClick={() => setView('postings')} className={view === 'postings' ? styles.activeTab : ''}>Postings</button>
        <button onClick={() => setView('applicants')} disabled={!selectedPostingId} className={view === 'applicants' ? styles.activeTab : ''}>Applicants</button>
        <button onClick={() => setView('interviews')} disabled={!selectedCandidateId} className={view === 'interviews' ? styles.activeTab : ''}>Interviews</button>
      </div>

      {view === 'postings' && (
        <PostingsTab onSelectPosting={id => { setSelectedPostingId(id); setView('applicants'); }} />
      )}
      {view === 'applicants' && selectedPosting && (
        <ApplicantsTab postingId={selectedPosting.id} pipelineStages={selectedPosting.pipeline_stages} />
      )}
      {view === 'interviews' && selectedCandidate && (
        <InterviewsTab candidateId={selectedCandidate.id} candidateName={selectedCandidate.full_name} />
      )}
    </div>
  );
}
```

Add the root-level tab-bar styles to `Hiring.module.css`:

```css
/* append to app/src/modules/Hiring/Hiring.module.css */
.hiring { padding: 20px; }
.tabBar { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
.tabBar button { padding: 8px 16px; background: none; border: none; cursor: pointer; font-size: 13px; color: var(--ink-3); }
.tabBar button:disabled { opacity: 0.4; cursor: not-allowed; }
.activeTab { color: var(--ink) !important; font-weight: 600; border-bottom: 2px solid var(--accent); }
```

- [ ] **Step 2: Wire the route guard in App.tsx**

Read `app/src/App.tsx` first to find the existing `/finance` route (added when the Finance module shipped) and copy its exact guard pattern. Add, following that same structure:

```typescript
// In App.tsx, alongside the existing /finance route:
<Route
  path="/hiring"
  element={canView(profile?.role, 'hiring') ? <Hiring /> : <Navigate to="/" replace />}
/>
```

Import `Hiring` from `./modules/Hiring` and add it next to the existing module imports.

- [ ] **Step 3: Wire the nav entry**

In the GlobalNav component, find where the Finance nav item is conditionally rendered (`canView(role, 'finance')`) and add a matching entry:

```typescript
{canView(profile?.role, 'hiring') && (
  <NavLink to="/hiring">Hiring</NavLink>
)}
```

(Match whatever the actual nav-item JSX pattern is in that file — this snippet shows the conditional-render logic; wrap it in the same element type as the Finance entry.)

- [ ] **Step 4: Manual smoke test — full walkthrough**

```bash
cd app
npm run dev
```

As a `finance` or `admin` role: confirm "Hiring" appears in the nav; as an `operator` role with no `posting_interviewers` row: confirm it's hidden from the nav AND that navigating directly to `/hiring` redirects away. Then, as a finance/admin user, walk the full flow: create a posting → set a JD → suggest a rubric → upload a resume → confirm a candidate record appears with an auto-score → move it through pipeline stages → book an interview → record a decision.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Hiring/index.tsx app/src/App.tsx app/src/components/GlobalNav.tsx
git commit -m "feat(hiring): wire Hiring module into nav + routing with 3-layer RBAC guard"
```

---

## Self-Review Notes

- **Spec coverage:** Postings tab + JD-driven rubric (Task 10, 7) ✓; two-path Applicants ingestion — stub creation (Task 5) + primary batch-upload enrichment (Task 6, 11) ✓; per-posting configurable stages (Task 3's `pipeline_stages`, surfaced in Task 11) ✓; Interviews tab + Calendly + decisions (Task 12) ✓; leadership + assigned-interviewer visibility (Task 1's RLS, Task 9's TS mirror, Task 13's 3-layer guard) ✓; 1-year retention (Task 8) ✓; activity_log entity refs (Task 6) ✓.
- **Known deferred items** (per the PRD's own open questions, intentionally not tasks here): pursuing Indeed's Employer API for direct resume retrieval, and LinkedIn ingestion — both are blocked on external decisions/evidence, not implementation work.
