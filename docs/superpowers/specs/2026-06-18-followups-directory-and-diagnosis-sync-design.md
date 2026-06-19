# Follow-Ups directory sidebar + diagnosis-call calendar sync — Design Spec

**Date:** 2026-06-18
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

Extend **Service → Follow-Ups** so an operator can, beside the existing month
calendar:

1. See **how many follow-ups are overdue** at a glance.
2. **Scroll through all customer profiles** in a right-hand directory and
   **filter** them by lifecycle status (multi-select, OR): overdue, due today,
   due in next 7 days, on hold, in follow-up, queued for replacement, active,
   awaiting onboarding, awaiting customer response, awaiting diagnosis,
   awaiting review, returned.
3. Have the calendar also surface **diagnosis calls** pulled from Huayi's
   Google Calendar — events titled **"LILA Diagnosis Chat"**.

## 2. Decisions (locked in)

| Decision | Choice |
|----------|--------|
| Status source | **Derive per-customer status set** from existing data (FU cadence, open service tickets, replacement orders, returns/refunds, onboarding lifecycle). No unified status column. Mirrors how Journey stage + `computeFuState` already work. |
| Filter behaviour | **Multi-select chips, OR semantics.** A customer can match several chips. Overdue count always shown. |
| "Awaiting review" | **New stored field** `customers.review_status` (no other backing data exists). |
| Diagnosis calls | **Build the Google Calendar reader now** + render diagnosis calls on the calendar. |

## 3. Components

### 3.1 Status derivation — `app/src/lib/followupStatus.ts` (new)

Pure, unit-testable core + a data-loading hook.

```
export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d'
  | 'on_hold' | 'in_followup' | 'queued_replacement'
  | 'active' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'awaiting_review' | 'returned';

export const STATUS_FILTERS: { key: FollowUpStatusKey; label: string }[]; // display order

export type CustomerStatusContext = {
  openTickets: ServiceTicket[];        // this customer's non-closed tickets
  queuedReplacement: boolean;          // has ready/awaiting unshipped replacement
  returned: boolean;                   // refunded return / refund_approval
  awaitingOnboarding: boolean;         // lifecycle: shipped & onboarding_status != 'completed'
};

export function computeCustomerStatuses(
  c: Customer, ctx: CustomerStatusContext, today: Date,
): Set<FollowUpStatusKey>;
```

Mapping (a customer may land in several):

| Key | Rule |
|-----|------|
| `overdue` | `computeFuState(c) ∈ {overdue_fu1, overdue_fu2}` |
| `due_today` | `computeFuState(c) ∈ {due_fu1, due_fu2}` |
| `due_7d` | next pending FU due date in `(today, today+7d]` |
| `on_hold` | an open ticket with `status='on_hold'` |
| `in_followup` | `onboard_date` set AND `computeFuState ∉ {complete, unscheduled}` |
| `queued_replacement` | `ctx.queuedReplacement` OR open ticket `status='queued_for_replacement'` |
| `active` | `onboard_date` set, `computeFuState='complete'`, no open ticket, not queued, not returned |
| `awaiting_onboarding` | `ctx.awaitingOnboarding` |
| `awaiting_response` | open ticket `status='waiting_on_customer'` |
| `awaiting_diagnosis` | open ticket `category='diagnosis_call'` (not closed) |
| `awaiting_review` | `c.review_status='requested'` |
| `returned` | `ctx.returned` |

"Open ticket" = `status != 'closed'`.

### 3.2 `useFollowUpDirectory()` hook — same module

Loads once and indexes by customer:
- `useCustomers()` (existing).
- `useServiceTickets()` (existing) — index by `customer_id`, else lowercased
  `customer_email`, else exact lowercased `customer_name`.
- `useQueuedReplacements()` (existing) — match replacement order → customer by
  `customer_email`/`customer_name`.
- Returns/refunds — load `refund_approvals` joined to `returns` where
  `status='refunded'` (reuse the query shape from `exportPurchasers`), plus
  returns with `status IN ('received','refunded')`; index by email/name.
- `customer_lifecycle` rows (shipped + `onboarding_status`) — index by
  `customer_id`.

Returns:
```
{
  rows: { customer: Customer; statuses: Set<FollowUpStatusKey>; fuState: FuState }[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  loading: boolean;
}
```

Matching helper `indexByCustomer` is a pure function (unit-tested).

### 3.3 New field — `customers.review_status`

- **Migration** `add_customer_review_status.sql`: `ALTER TABLE customers ADD
  COLUMN review_status text;` (null = not asked, `'requested'` = ask sent,
  `'received'` = review received). No check constraint (matches `fu*_status`
  free-text convention).
- `Customer` type gains `review_status: string | null`.
- `setReviewStatus(customerId, status)` mutation in `customers.ts` →
  `logAction('review_status_set', …)`.

### 3.4 Sidebar UI

- `FollowUpsTab.tsx`: two-column layout — calendar left (~60%), directory
  right (~40%); stacks on mobile (reuse existing media-query pattern).
- New `FollowUpDirectory.tsx`:
  - Header: **overdue count** badge ("N follow-ups overdue").
  - Multi-select filter chips from `STATUS_FILTERS`, each with its count from
    `counts`. Selecting ≥1 filters the list to customers matching ANY selected
    key; none selected = show all.
  - Scrollable list of customer cards: name, status tags, onboard date, FU
    state, email/phone. Click selects the customer.
- Selected-customer panel (extend the existing `selectedPanel` in
  `FollowUpsTab`): FU actions (Called/Messaged/Reviewed → `recordFollowUp`),
  **review-status buttons** ("Mark review requested" / "Mark review received"
  → `setReviewStatus`), and a link into their tickets (open `TicketDetailPanel`).
- CSS in `FollowUps.module.css`.

### 3.5 Diagnosis-call calendar sync

- **Refactor** the Google auth + calendar helpers out of
  `supabase/functions/sync-calendly-events/index.ts` into
  `supabase/functions/_shared/google-calendar.ts`
  (`getCalendarAccessToken`, `listCalendarEvents`, `addAttendeesToCalendarEvent`).
  Keep `sync-calendly-events` behaviour identical (import from the shared
  module).
- **New edge function** `supabase/functions/sync-google-calendar-diagnosis/index.ts`:
  - Auth: existing `GOOGLE_SERVICE_ACCOUNT_KEY` (domain-wide delegation),
    delegated subject `DIAGNOSIS_CALENDAR_MAILBOX` (default `huayi@virgohome.io`).
  - `events.list` over a rolling window (`timeMin = now-7d`, `timeMax =
    now+60d`, `singleEvents=true`).
  - Keep events whose `summary` contains `DIAGNOSIS_EVENT_NAME_MATCH`
    (default `"LILA Diagnosis Chat"`).
  - Upsert into `service_tickets`: `category='diagnosis_call'`,
    `source='google_calendar'`, `google_calendar_event_id=<event id>` (dedupe
    key, already a column), `calendly_event_start=<event start ISO>` (so it
    renders on the calendar with no UI change to the time source),
    `subject`, `customer_name`/`customer_email` from the non-organizer attendee
    when present, `status='call_scheduled'`.
  - **Dedup vs Calendly diagnosis tickets:** before insert, skip if an existing
    `diagnosis_call` ticket has the same customer email/name AND a
    `calendly_event_start` within ±15 minutes (avoid double-listing the same
    call that also arrived via Calendly).
  - Idempotent: re-runs upsert on `google_calendar_event_id`.
- **Schedule:** add a `pg_cron` job (or extend the existing cron migration
  pattern) invoking the function on an interval; confirm the repo's existing
  cron mechanism in the plan and follow it.
- **Config:** register the function in `supabase/config.toml`
  (`verify_jwt=false`, matching `sync-calendly-events`).

### 3.6 Calendar rendering of diagnosis calls

`FollowUpsTab` already renders `category='onboarding'` tickets with a
`calendly_event_start` as `CallEvent`. Add a parallel branch for
`category='diagnosis_call'` tickets with a start → a distinct event type
(`'diagnosis'`) with its own colour + legend entry; click opens the
`TicketDetailPanel`. Onboarding-call rendering is unchanged.

## 4. Data flow

```
Google Calendar (Huayi) ──sync-google-calendar-diagnosis──▶ service_tickets(category=diagnosis_call)
                                                                    │
customers ─┐                                                        │
tickets ───┤                                                        ▼
orders ────┼──▶ useFollowUpDirectory() ──▶ FollowUpDirectory (chips + list + overdue count)
returns ───┤                                   FollowUpsTab calendar (FU + onboarding + diagnosis)
lifecycle ─┘
```

## 5. Error handling

- Hook tolerates partial load failures (a failed source → that signal treated
  as absent, list still renders); never throws to the calendar.
- Edge function: returns a `{ scanned, matched, upserted, skipped }` summary;
  on Google API error returns 502 with the message; never partially commits a
  malformed event (validate id + start before upsert).
- Name/email matching is best-effort; unmatched tickets/orders simply don't
  attribute to a customer (no crash).

## 6. Testing

- **Vitest (pure):**
  - `computeCustomerStatuses` — one case per status key + a multi-status case
    + the `active` exclusion logic.
  - `due_7d` window boundaries (today, +7, +8).
  - `indexByCustomer` matching precedence (customer_id > email > name).
  - Diagnosis title-match + ±15-min dedupe helper.
- **Build:** `npm run build` + `npm test` green.
- **Manual (post-deploy):** run `sync-google-calendar-diagnosis` once with the
  real service-account secret covering Huayi's calendar; confirm a known
  "LILA Diagnosis Chat" event appears as a diagnosis ticket and on the
  calendar. **The live Google fetch cannot be verified from the dev
  environment.**

## 7. Scope / risk

- Parts 3.1–3.4 + 3.6 are frontend + one migration — fully testable here.
- Part 3.5 (Google Calendar reader) is backend/infra: depends on the
  service-account secret covering Huayi's calendar, function deploy, and a
  cron schedule. Highest risk; verified manually after deploy.

## 8. Out of scope

- No backfill of historical diagnosis calls beyond the rolling window.
- No new "review request" email/automation — `review_status` is set manually
  by the operator (a send/automation can come later).
- No change to onboarding-call ingestion or the FU cadence.
