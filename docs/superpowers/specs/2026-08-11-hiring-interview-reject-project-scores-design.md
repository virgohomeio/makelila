# Hiring: interview-stage Reject + take-home project scores — Design

**Date:** 2026-08-11
**Owner:** Huayi
**Status:** Approved

## Problem

Rejection today is a single undifferentiated state: the Applicants board's Reject button sets
`candidates.rejected_at`, and there is no way to reject a candidate from the Interviews board at
all. Operators need (1) a Reject button after interviews, and (2) the two rejection populations —
rejected at resume screening vs rejected after an interview — kept apart. Separately, candidates
who reach the post-interview stage receive a take-home project with 2 questions, and there is
nowhere to record their scores on it.

## Decisions

- **Explicit stage column, not derivation.** A nullable `candidates.rejection_stage`
  (`'resume_screening' | 'interview'`) written by the reject mutation. Deriving the stage from
  "does the candidate have a held interview" was rejected: it needs an interviews fetch per
  candidate card (N+1 on the Applicants board) and mislabels a candidate whose interview was
  booked but whose rejection was really about the resume.
- **Backfill existing rejections as `resume_screening`** — the interview-stage Reject button did
  not exist before this change, so every historical rejection came from the Applicants board.
- The interview Reject button lives in the expanded `CandidateInterviewPanel` on the Interviews
  board. Rejecting clears `hired_at` (the shortlist marker), so the candidate drops off the
  Interviews board and shows on the Applicants board tagged **Rejected — interview**.
  Applicants-board rejections tag **Rejected — resume screen**. Clicking Shortlist again reverses
  either, per the 2026-07-31 decision-tags design.
- **Project scores as jsonb**, mirroring the screening `scores` column: new
  `candidates.project_scores jsonb not null default '{}'`, keyed by the fixed question labels
  (`"Question 1"`, `"Question 2"`). Scores use the module's existing 1–5 scale. Per-posting
  configurable project questions were rejected as speculative — the project is one fixed
  2-question exercise today.

## Design

### Migration — `supabase/migrations/20260811120000_hiring_rejection_stage_project_scores.sql`

- `alter table candidates add column rejection_stage text check (rejection_stage in
  ('resume_screening','interview'))`, nullable.
- `add column project_scores jsonb not null default '{}'::jsonb`.
- Backfill `rejection_stage = 'resume_screening'` where `rejected_at is not null`.
- No RLS changes: `candidates_update` already covers operator writes to the new columns; the
  service-role sync/parse inserts are unaffected (both columns have defaults / allow null).

### Data layer — `app/src/lib/hiring.ts`

- `export type RejectionStage = 'resume_screening' | 'interview'`.
- `Candidate` gains `rejection_stage: RejectionStage | null` and
  `project_scores: Record<string, number>`; both added to `CANDIDATE_COLUMNS`.
- `rejectCandidate(candidateId, stage: RejectionStage)` — now also writes `rejection_stage`.
  Call sites: Applicants board passes `'resume_screening'`, interview panel passes `'interview'`.
- `hireCandidate` additionally clears `rejection_stage` (a shortlisted candidate carries no
  rejection residue).
- `export const PROJECT_QUESTIONS = ['Question 1', 'Question 2']` — the fixed take-home labels.
- `recordProjectScores(candidateId, scores)` — writes `project_scores`, mirroring
  `recordCandidateScore`.

### UI — `ApplicantsTab.tsx` (`CandidateCard`)

- The Rejected pill's label becomes stage-aware: `rejection_stage === 'interview'` →
  **Rejected — interview**; otherwise (resume_screening or legacy null) →
  **Rejected — resume screen**. Same `.decisionRejected` pill styling for both.

### UI — `InterviewsTab.tsx` (`CandidateInterviewPanel`)

- A **Reject** button under the panel heading calls `rejectCandidate(id, 'interview')`; the
  realtime refetch in `useCandidates` then removes the candidate from the board. Inline error
  state on failure, button disabled while in flight. The `<h4>` stays a direct child of the
  panel root (test helpers locate the panel via `heading.parentElement`).
- A **Project — 2 questions** block at the bottom of the panel (after the invite block, matching
  the screen → interview → project chronology): one `scoreRow` per `PROJECT_QUESTIONS` entry with
  a 1–5 number input seeded from `candidate.project_scores`, a "Save project scores" button
  calling `recordProjectScores`, a "Saved" hint on success, inline error on failure.

## Testing

- `hiring.test.ts`: `rejectCandidate` writes `rejection_stage` for both stages; `hireCandidate`
  clears it; `recordProjectScores` writes `project_scores`.
- `CandidateCard.test.tsx`: pill reads "Rejected — resume screen" / "Rejected — interview" by
  stage, with legacy null falling back to resume screen; reject button passes
  `'resume_screening'`.
- `InterviewsTab.test.tsx`: panel Reject calls `rejectCandidate(id, 'interview')`; project inputs
  seed from saved scores and save via `recordProjectScores`.

## Out of scope

- No `logAction()` calls (module-wide hiring audit logging remains its own task).
- No filtering/grouping of rejected candidates beyond the stage-labeled pill.
- No per-posting project question configuration; no project file/submission storage.
