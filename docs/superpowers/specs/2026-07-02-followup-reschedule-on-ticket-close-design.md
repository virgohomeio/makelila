# Follow-Up Hold & Reschedule on Ticket Close — Design

**Date:** 2026-07-02
**Module:** Service → Follow-Ups
**Status:** Approved (design)

## Problem

Under **Service → Follow-Ups**, onboarding follow-ups (FU1, FU2) for a customer who
currently has an **open support ticket** should be put on hold. Once the customer's
open tickets are all closed, the pending follow-ups should be **rescheduled** relative
to the ticket close date:

- **FU1 → 2 weeks (14 days) after the ticket closes**
- **FU2 → 4 weeks (28 days) after the ticket closes**

## Current state (what already exists)

The Follow-Ups system is entirely **derived at read-time** from `customers` +
`service_tickets` — there is no stored follow-up schedule and no follow-up cron.

- **Hold already works.** [`computeCustomerStatuses`](../../../app/src/lib/followupStatus.ts)
  sets a derived `fu_on_hold` status when a customer has a pending follow-up and an
  open *issue* ticket (or a queued replacement). The UI reflects it:
  [`FollowUpDetailPanel.tsx`](../../../app/src/modules/Service/FollowUpDetailPanel.tsx)
  shows a pause banner and hides the FU action buttons;
  [`FollowUpsTab.tsx`](../../../app/src/modules/Service/FollowUpsTab.tsx) drops the FU
  markers off the calendar while held.
- **Reschedule does NOT work.** FU1/FU2 are anchored permanently to
  `customers.onboard_date` (+14 / +28 days) in
  [`computeFuState`](../../../app/src/lib/customers.ts) and in the calendar. When the
  hold lifts, the dates snap back to the *original* onboard-based schedule — so a
  follow-up whose original due date has passed reappears as overdue instead of being
  pushed out.
- The detail-panel copy **already promises** the reschedule
  ("They'll auto-reschedule to 14/28 days after the ticket close date"), so this work
  finishes an already-advertised behavior.

A separate, unrelated feature — the **post-close ticket follow-up** (a single follow-up
due `closed_at + 14d`, tracked via `service_tickets.post_close_followup_done_at`) — must
remain untouched.

## Requirements (confirmed)

1. **Which follow-ups:** the onboarding FU1 & FU2 sequence only.
2. **Which tickets trigger hold + reschedule:** **any** open ticket, of any category
   (broadening the current issue-only rule — see Behavior Changes).
3. **Partial completion:** reschedule only what's still pending; a completed touch stays
   done.
4. **Timing:** FU1 = close + 14d, FU2 = close + 28d.
5. **Multiple open tickets:** stay on hold until *all* are closed; then anchor to the
   most-recent close date.

## Approach — derived re-anchoring at read-time (chosen)

Keep the derived architecture. Introduce an **effective follow-up anchor** that the
FU cadence counts from, replacing the direct use of `onboard_date`.

Rejected alternatives:
- **Stored anchor column + daily pg_cron** — persisted/auditable but adds a migration,
  a cron, and drift risk; cron/edge deploys are constrained in this environment.
- **Write the anchor on the ticket-close mutation** — misses tickets closed by the
  auto-close cron and by HubSpot sync, which don't go through the UI mutation.

## Design

### 1. Effective anchor helper (pure)

```
effectiveFollowUpAnchor(customer, ctx): string | null   // ISO YYYY-MM-DD, or null if unscheduled
```

- If `customer.onboard_date` is null → `null` (unscheduled; unchanged).
- Base anchor = `onboard_date`.
- If the customer has **no open tickets** and a **most-recent-closed ticket** (any
  category) whose close date is *after* `onboard_date`, shift the anchor to that close
  date: `anchor = max(onboard_date, lastClosedAnyTicketAt)`.
- While any ticket is open, the customer is on hold, so the anchor is not surfaced
  (no due markers) regardless.

FU due dates derive from the anchor: **FU1 = anchor + 14d, FU2 = anchor + 28d.**
Because this is a straight anchor shift, an already-completed FU1 stays done and only
the still-pending touch moves — satisfying "reschedule only what's pending." If only
FU2 is pending it lands at close + 28d (4 weeks), per requirement 4.

### 2. `customers.ts` refactor

- Extract due-date math into `followUpDueDates(anchorIso)` returning `{ fu1Due, fu2Due }`.
- `computeFuState(c, today, anchorIso?)` — optional third arg overrides `onboard_date`
  for the +14/+28 math; the `complete` / `unscheduled` branches still key off
  `onboard_date` presence and the `fu1_status` / `fu2_status` fields.
- Backward compatible: existing callers that omit `anchorIso` behave exactly as today.

### 3. `followupStatus.ts` changes

- Add `lastClosedAnyTicketAt: string | null` to `CustomerStatusContext` (most-recent
  `closed_at` across **all** ticket categories). The existing issue-only
  `lastClosedTicket` stays for the post-close follow-up feature.
- Add `effectiveFollowUpAnchor(c, ctx)`.
- Broaden the block condition: `blockingCondition` uses `ctx.openTickets.length > 0`
  (any open ticket) instead of `openIssueTickets.length > 0`.
- Thread the effective anchor into `computeFuState(...)` and `daysToNextFu(...)` so
  `overdue` / `due_today` / `due_7d` / `in_followup` all reflect rescheduled dates.
- In `useFollowUpDirectory`, populate `lastClosedAnyTicketAt` while iterating tickets
  (track the max `closed_at` per customer across all categories, in addition to the
  existing issue-only `lastClosedByCustomer`).

### 4. `FollowUpsTab.tsx` (calendar)

Position FU1/FU2 markers from the effective anchor instead of raw `onboard_date`.
Compute the same anchor per customer (reuse the helper; supply the same
`lastClosedAnyTicketAt` / open-ticket data the directory builds, or expose the anchor
via the directory rows). The existing "skip blocked customers" guard stays — held
customers show no markers; once unblocked, markers appear at the rescheduled dates.

### 5. `FollowUpDetailPanel.tsx`

The "resume 14/28 days after close" copy is already correct. Verify the FU due-date
display reflects the rescheduled dates (it should, once `computeFuState` uses the
anchor). No copy change expected.

## Behavior changes (call out in review)

- **Any open ticket now holds follow-ups** (previously issue-tickets-only). Onboarding
  and diagnosis-call tickets will now also hold FU1/FU2. Practical impact is limited:
  an open **onboarding** ticket usually coincides with a null `onboard_date`
  (follow-ups unscheduled anyway), and **diagnosis** already suppresses FU1/FU2 via its
  own branch. Net new effect is mostly open onboarding tickets that have a set
  `onboard_date`.

## Testing

Unit tests (Vitest, next to the libs):

- `effectiveFollowUpAnchor`: null onboard → null; no closed ticket → onboard_date;
  closed ticket after onboard → close date; closed ticket before onboard → onboard_date;
  open ticket present → still returns base (hold governs surfacing).
- Reschedule: both pending → FU1 = close+14, FU2 = close+28.
- Partial completion: FU1 done, FU2 pending → FU2 = close+28, no FU1 marker.
- Multiple tickets: two closed → anchor = latest close; one still open → on hold.
- `computeFuState` back-compat: no `anchorIso` arg → identical to prior behavior.

## Trade-off accepted

Rescheduling is derived, so there is no discrete "rescheduled" audit-log entry. The
ticket-close event is already logged and the new dates are deterministic from it, so no
information is lost.

## Out of scope

- The separate post-close ticket follow-up (`closed_at + 14d`) — unchanged.
- Diagnosis-call follow-up handling — unchanged.
- Any stored schedule, migration, cron, or edge function.
