# Diagnosis call supersedes cadence + 2-week diagnosis follow-up — Design Spec

**Date:** 2026-06-18
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

When a customer has had OR is scheduled for a **diagnosis call**, their normal
FU1/FU2 cadence is **superseded**: normal follow-ups are held, and a dedicated
**diagnosis follow-up** is scheduled for **the diagnosis-call date + 14 days**.
Once that diagnosis follow-up is completed, the customer is resolved (normal
FU1/FU2 do NOT resume).

## 2. Definitions & decisions (locked in)

| Item | Choice |
|------|--------|
| "Diagnosis call" | a `service_tickets` row with `category='diagnosis_call'` and a `calendly_event_start` (the call date/time). Scheduled = future, had = past. Any status (open OR closed). |
| Diagnosis follow-up date | latest active diagnosis call's `calendly_event_start` **+ 14 days**. |
| Completion | **new `service_tickets.diagnosis_followup_done_at` timestamp** + a "Mark diagnosis follow-up done" action. |
| After completion | **Resolved — no auto-resume** of FU1/FU2. |
| Send queue | `diag_followup_due` is its own track (likely a call) — NOT pushed into the SMS draft/send queue. |

## 3. Components

### 3.1 Migration + ticket field + mutation
- **Migration** `add_diagnosis_followup_done_at.sql`:
  `ALTER TABLE public.service_tickets ADD COLUMN IF NOT EXISTS diagnosis_followup_done_at timestamptz;`
  (null = follow-up not done.)
- `service.ts`: add `diagnosis_followup_done_at: string | null` to `ServiceTicket`.
- `service.ts`: `markDiagnosisFollowupDone(ticketId)` → set the stamp to now,
  `logAction('diagnosis_followup_done', ticketId, …)`.

### 3.2 Derivation — `computeCustomerStatuses` (`app/src/lib/followupStatus.ts`)
- Extend `CustomerStatusContext` with
  `diagnosisCalls: { startIso: string | null; followupDoneAt: string | null }[]`
  (from ALL the customer's `diagnosis_call` tickets, any status).
- New constant `DIAG_FOLLOWUP_DAYS = 14`.
- Logic (replaces today's cadence/hold block):
  ```
  hasAnyDiag = ctx.diagnosisCalls.length > 0
  activeDiag = ctx.diagnosisCalls.filter(d => d.startIso && !d.followupDoneAt)
  latestActiveStart = max(activeDiag.startIso)        // ISO string max == latest
  diagDue = latestActiveStart && today >= latestActiveStart + 14d

  BLOCKING_TICKET_CATEGORIES = ['support', 'repair']   // diagnosis_call REMOVED
  blockingCondition = ctx.queuedReplacement
                   || ctx.openTickets.some(t => BLOCKING_TICKET_CATEGORIES.includes(t.category))
  pendingFu = onboard_date set && fu ∉ {complete, unscheduled}

  if (hasAnyDiag) {
    if (activeDiag.length > 0) { diagDue ? add 'diag_followup_due' : add 'fu_on_hold'; }
    // all done → resolved: add nothing (normal cadence suppressed)
  } else if (pendingFu && blockingCondition) {
    add 'fu_on_hold'
  } else {
    // normal cadence
    overdue / due_today / due_7d / in_followup as today
  }
  ```
- Other tags unchanged: `on_hold` (ticket status), `awaiting_response`,
  `awaiting_diagnosis` (open diagnosis ticket — kept as an informational tag),
  `queued_replacement`, `awaiting_onboarding`, `awaiting_review`, `returned`,
  `active`.
- New status key **`diag_followup_due`** ("Diagnosis follow-up due") added to
  `FollowUpStatusKey` + `STATUS_FILTERS` immediately after `fu_on_hold`.

### 3.3 Hook — `useFollowUpDirectory`
- Build `diagnosisCallsByCustomer` from ALL `diagnosis_call` tickets (NOT
  filtered to non-closed), matched to customers by id/email/name, each entry
  `{ startIso: t.calendly_event_start, followupDoneAt: t.diagnosis_followup_done_at }`.
- Pass `diagnosisCalls: diagnosisCallsByCustomer.get(c.id) ?? []` into the ctx.

### 3.4 Calendar — `FollowUpsTab.tsx`
- The `FollowUpCalendar` `tickets` prop shape gains
  `diagnosis_followup_done_at: string | null`.
- In `eventsByDay`, for each ticket with `category==='diagnosis_call'`,
  `calendly_event_start`, and `diagnosis_followup_done_at == null`, add a
  **diagnosis-follow-up event** on `start + 14 days` (a distinct call kind,
  e.g. `'diag_followup'`, teal) labelled with the customer; click → `onCallClick(ticketId)`
  (opens the ticket). Add a legend entry. (On-hold customers' normal FU markers
  are already suppressed via `blockedCustomerIds`.)

### 3.5 Mark-done UI — `TicketDetailPanel.tsx`
- For `category==='diagnosis_call'` tickets, show the diagnosis-follow-up due
  date (`calendly_event_start + 14d`) and a **"Mark diagnosis follow-up done"**
  button when `diagnosis_followup_done_at` is null → `markDiagnosisFollowupDone(ticket.id)`.
  When already done, show "Diagnosis follow-up done <date>".

## 4. Data flow
```
service_tickets(diagnosis_call, calendly_event_start, diagnosis_followup_done_at)
  → useFollowUpDirectory: diagnosisCallsByCustomer → ctx.diagnosisCalls
  → computeCustomerStatuses: fu_on_hold / diag_followup_due / suppress normal FU
  → directory chips + FollowUpCalendar (diag follow-up marker at call+14d)
  → TicketDetailPanel "Mark diagnosis follow-up done" → stamp → un-holds (resolved)
```

## 5. Error handling
- Pure derivation; no new failure modes. Missing `startIso` entries are ignored
  (not active). Mutation surfaces Supabase errors to the caller.

## 6. Testing
Vitest on `computeCustomerStatuses` (extend `CustomerStatusContext` test fixtures
with `diagnosisCalls: []` default):
- Scheduled (future) call → `fu_on_hold`; normal `overdue` suppressed.
- Past call < 14 days ago, not done → `fu_on_hold`.
- Past call ≥ 14 days ago, not done → `diag_followup_due` (and not `overdue`).
- Follow-up done → no `diag_followup_due`/`fu_on_hold` from diagnosis; normal FU
  stays suppressed (resolved).
- No onboard_date but a past diagnosis call ≥14d → `diag_followup_due`.
- Open `support` ticket (no diagnosis) still → `fu_on_hold` (unchanged).
- Update `STATUS_FILTERS` order test (13 → 14 keys, `diag_followup_due` after
  `fu_on_hold`).
Gates: `npm run lint` (exit 0 — deploy gate), `npm test`, `npm run build`.

## 7. Scope / out of scope
- No edge-function change. No change to how diagnosis calls are ingested.
- `diag_followup_due` not added to the SMS draft/send queue.
- No auto-resume of FU1/FU2 after the diagnosis follow-up.
