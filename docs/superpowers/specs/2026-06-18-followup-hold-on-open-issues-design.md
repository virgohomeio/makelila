# Hold follow-ups while a replacement/ticket is unresolved — Design Spec

**Date:** 2026-06-18
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

In Service → Follow-Ups, automatically **put a customer's follow-up on hold**
when they have an unresolved issue — a queued replacement or an open
support/repair/diagnosis ticket — so no follow-up is chased or sent until it's
sorted out. Resume automatically once resolved.

## 2. Decisions (locked in)

| Decision | Choice |
|----------|--------|
| Block trigger | `queuedReplacement` **OR** any non-closed ticket of category `support`/`repair`/`diagnosis_call`. Onboarding-call tickets do NOT block. |
| Effect | While blocked, suppress `overdue`/`due_today`/`due_7d`/`in_followup`; surface a new **`fu_on_hold`** status ("Follow-up on hold"). Excluded from the overdue count + draft/send queue. |
| Resume | Automatic — recomputed each render; no manual unblock. |
| Backstop | Existing `generate-followup-drafts` auto-skip stays; no edge-function change. |

## 3. Components

### 3.1 `computeCustomerStatuses` — `app/src/lib/followupStatus.ts`
Add, near the top of the function (after `const fu = computeFuState(...)`):
```ts
const BLOCKING_TICKET_CATEGORIES = ['support', 'repair', 'diagnosis_call'];
const blockingCondition =
  ctx.queuedReplacement
  || ctx.openTickets.some(t => BLOCKING_TICKET_CATEGORIES.includes(t.category));
const pendingFu = !!c.onboard_date && fu !== 'complete' && fu !== 'unscheduled';
const fuBlocked = pendingFu && blockingCondition;
```
- Gate the cadence statuses: only add `overdue`/`due_today`/`due_7d`/`in_followup`
  when `!fuBlocked`. When `fuBlocked`, add `'fu_on_hold'` instead.
- All other tags unchanged: `on_hold` (ticket status), `awaiting_response`,
  `awaiting_diagnosis`, `queued_replacement`, `awaiting_onboarding`,
  `awaiting_review`, `returned`, and `active` (already excludes any open issue).

`ctx.openTickets` is `Pick<ServiceTicket,'status'|'category'>[]`, already filtered
to non-closed tickets by `useFollowUpDirectory`.

### 3.2 New status key `fu_on_hold`
- Add `'fu_on_hold'` to the `FollowUpStatusKey` union.
- Add to `STATUS_FILTERS` immediately after `due_7d`:
  `{ key: 'fu_on_hold', label: 'Follow-up on hold' }`. (List goes 12 → 13 keys.)
- Surfaces as a directory filter chip with a live count automatically.

### 3.3 Overdue draft/send queue — no change needed
`FollowUpsTab` derives `overdueCustomerIds = rows where statuses has 'overdue'
|| 'due_today'`. Blocked customers no longer carry those, so they drop out of
the send queue and the "⚠ N overdue" banner automatically. Confirm in testing.

### 3.4 Calendar suppression — `app/src/modules/Service/FollowUpsTab.tsx`
- Compute `blockedCustomerIds = new Set(rows.filter(r => r.statuses.has('fu_on_hold')).map(r => r.customer.id))`.
- Pass it to `FollowUpCalendar` as a new prop `blockedCustomerIds: Set<string>`.
- In `FollowUpCalendar`'s FU-event loop (`for (const c of customers)` that adds
  fu1/fu2 events), `continue` when `blockedCustomerIds.has(c.id)`. Onboarding
  and diagnosis-call events are unaffected.

### 3.5 Directory tag styling (optional, minor)
The `fu_on_hold` tag renders via the existing `dirTag` with `data-status`.
Leave default styling (no new CSS required); a muted/amber treatment can be a
follow-up.

## 4. Data flow
```
useFollowUpDirectory → rows (each: customer, statuses incl. fu_on_hold, fuState)
   → FollowUpDirectory chips/list (fu_on_hold chip + tag)
   → overdueCustomerIds (overdue ∪ due_today)  ── blocked excluded → OverdueFollowupPanel
   → blockedCustomerIds (fu_on_hold) ──→ FollowUpCalendar suppresses their FU markers
```

## 5. Error handling
- Pure function; no new failure modes. If `ctx.openTickets` is empty or
  `queuedReplacement` false, behavior is exactly as today.

## 6. Testing
Vitest on `computeCustomerStatuses`:
- Blocked by queued replacement → `fu_on_hold` present, `overdue`/`due_today`
  absent, `queued_replacement` present.
- Blocked by open `support` ticket (customer otherwise FU1-overdue) → `fu_on_hold`,
  no `overdue`.
- Open `onboarding` ticket does NOT block → `overdue` still present, no `fu_on_hold`.
- Completed customer (both FU done) with an open ticket → no `fu_on_hold`
  (nothing pending), not `overdue`.
- Unscheduled customer (no onboard_date) with a ticket → no `fu_on_hold`.
- Auto-resume: same customer with no blocking condition → `overdue` returns.
- Update the `STATUS_FILTERS` order test to the 13-key list.

Gates: `cd app && npm run lint` (exit 0 — deploy gate), `npm test`,
`npm run build` all green. Calendar suppression verified via derivation tests +
a manual check.

## 7. Scope / out of scope
- One cohesive change; mostly the pure derivation + a small calendar prop.
- No DB/schema change, no edge-function change.
- No manual override UI (auto resume only) — can be added later if needed.
