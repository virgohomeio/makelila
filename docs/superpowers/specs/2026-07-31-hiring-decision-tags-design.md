# Hiring: Shortlisted/Rejected decision tags on candidate cards — Design

**Date:** 2026-07-31
**Owner:** Huayi
**Status:** Approved

## Problem

On the Hiring tab's Applicants board, the Hire and Reject buttons write `hired_at` /
`rejected_at` to the `candidates` row, but the candidate card never displays that state —
clicking either button appears to do nothing. Operators need a visible tag on the candidate
profile showing whether they've been shortlisted or rejected.

## Decisions (from brainstorm)

- The Hire action is reinterpreted as **shortlisting**: its tag reads **Shortlisted** and the
  button is relabeled **Shortlist**. DB columns and lib function names (`hired_at`,
  `hireCandidate`) are unchanged — label-only rename.
- Reject tags the candidate **Rejected**.
- Both buttons stay visible and active after a decision; clicking the other one switches the
  tag. No separate Undo affordance.
- Approach: derive the tag from the existing `hired_at` / `rejected_at` timestamps. No schema
  change, no migration.

## Design

### Data layer — `app/src/lib/hiring.ts`

- `hireCandidate(id)` → `update({ hired_at: now, rejected_at: null })`
- `rejectCandidate(id)` → `update({ rejected_at: now, hired_at: null })`

The mutual-null guarantees at most one tag per candidate and makes switching a single click.

### UI — `app/src/modules/Hiring/ApplicantsTab.tsx` (`CandidateCard`)

- Derive decision: `hired_at` set → `shortlisted`; else `rejected_at` set → `rejected`; else
  none. If a legacy row has both, `hired_at` wins (new rows can't — the mutations clear the
  opposing column).
- Render a pill next to the candidate's name (same placement/pattern as the stub badge):
  **Shortlisted** (green) or **Rejected** (red).
- Relabel the "Hire" button to **"Shortlist"**.
- The realtime subscription in `useCandidates` already re-fetches on update, so the tag
  appears/switches without a manual refresh.

### CSS — `app/src/modules/Hiring/Hiring.module.css`

- `.decisionShortlisted` — `#DCFCE7` / `#166534` (matches `.statusOpen` palette)
- `.decisionRejected` — `#FEE2E2` / `#991B1B` (matches `.uploadError` palette)
- Both on the existing pill geometry (`.stubBadge` shape).

## Testing

- Extend `app/src/lib/hiring.test.ts`: `hireCandidate` clears `rejected_at`;
  `rejectCandidate` clears `hired_at`.
- Manual UAT: click Shortlist → green tag appears; click Reject on the same card → tag
  switches to red.

## Out of scope

- No `logAction()` calls (the hiring lib consistently doesn't log; adding audit logging
  module-wide is its own task).
- No filtering/hiding of decided candidates.
- No changes to InterviewsTab or the interview-level decision flow.
