# Diagnosis-Call Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A diagnosis call (had or scheduled) supersedes a customer's normal FU1/FU2 cadence: hold the normal cadence and surface a diagnosis follow-up due at call+14 days, completed via a new ticket stamp; once done the customer is resolved (no auto-resume).

**Architecture:** New `service_tickets.diagnosis_followup_done_at` timestamp + `markDiagnosisFollowupDone` mutation; `computeCustomerStatuses` gains a `diagnosisCalls` context and a `diag_followup_due` status; `useFollowUpDirectory` feeds all diagnosis-call tickets in; the Follow-Ups calendar renders a diagnosis-follow-up marker at call+14d and `TicketDetailPanel` gets a "Mark diagnosis follow-up done" button.

**Tech Stack:** React 18 + TS, Supabase, CSS Modules, Vitest. Spec: `docs/superpowers/specs/2026-06-18-diagnosis-call-followup-design.md`. **Pages deploy runs `npm run lint` (exit 1 on any error) before build — lint MUST be clean.** Work on `main`; each task verified green.

---

### Task 1: Migration + `ServiceTicket` field + mutation

**Files:**
- Create: `supabase/migrations/20260618140000_diagnosis_followup_done_at.sql`
- Modify: `app/src/lib/service.ts`

- [ ] **Step 1: Migration file** (controller applies it to prod; just create the file):
```sql
-- Completion stamp for the post-diagnosis-call follow-up (call date + 14 days).
-- null = follow-up not yet done. Drives the Follow-Ups "diagnosis follow-up" track.
ALTER TABLE public.service_tickets
  ADD COLUMN IF NOT EXISTS diagnosis_followup_done_at timestamptz;
COMMENT ON COLUMN public.service_tickets.diagnosis_followup_done_at IS
  'When the 2-week post-diagnosis-call follow-up was completed (null = pending).';
```

- [ ] **Step 2:** In `app/src/lib/service.ts`, add to the `ServiceTicket` type near the other diagnosis fields (`diagnosis_link_sent_at`, `diag_cohost_invited_at`, `google_calendar_event_id`):
```ts
  diagnosis_followup_done_at: string | null;
```

- [ ] **Step 3:** Add the mutation (near `markDiagnosisLinkSent`):
```ts
/** Mark the 2-week post-diagnosis-call follow-up complete (stamps now). */
export async function markDiagnosisFollowupDone(ticketId: string): Promise<void> {
  const doneAt = new Date().toISOString();
  const { error } = await supabase
    .from('service_tickets')
    .update({ diagnosis_followup_done_at: doneAt })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('diagnosis_followup_done', ticketId, doneAt);
}
```
(Confirm `logAction` + `supabase` are already imported in this file — they are.)

- [ ] **Step 4:** `cd app && npx tsc --noEmit` (clean) + `npm run lint` (exit 0).

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260618140000_diagnosis_followup_done_at.sql app/src/lib/service.ts
git commit -m "feat(service): diagnosis_followup_done_at column + markDiagnosisFollowupDone"
```

---

### Task 2: Derivation — diagnosis supersede + `diag_followup_due` (TDD)

**Files:**
- Modify: `app/src/lib/followupStatus.ts`
- Modify: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Add failing tests.** In `followupStatus.test.ts`, first update `emptyCtx` to include the new field:
```ts
const emptyCtx: CustomerStatusContext = {
  openTickets: [], queuedReplacement: false, returned: false, awaitingOnboarding: false,
  diagnosisCalls: [],
};
```
Append a new describe block (uses module-level `base`, `today`, `daysAgo`):
```ts
describe('diagnosis-call follow-up', () => {
  const call = (startIso: string, followupDoneAt: string | null = null) => ({ startIso, followupDoneAt });

  it('holds normal FU when a diagnosis call is scheduled in the future', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // would be FU1 overdue
    const s = computeCustomerStatuses(c, { ...emptyCtx, diagnosisCalls: [call(daysAhead(3))] }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('diag_followup_due')).toBe(false);
  });

  it('holds when a past diagnosis call is < 14 days ago', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, diagnosisCalls: [call(daysAgo(5))] }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('diag_followup_due')).toBe(false);
  });

  it('marks diag_followup_due once the call is >= 14 days ago and not done', () => {
    const c = { ...base, onboard_date: daysAgo(40) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, diagnosisCalls: [call(daysAgo(14))] }, today);
    expect(s.has('diag_followup_due')).toBe(true);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('fu_on_hold')).toBe(false);
  });

  it('resolves (no diag/normal FU statuses) once the follow-up is done', () => {
    const c = { ...base, onboard_date: daysAgo(40) }; // FU would be overdue
    const s = computeCustomerStatuses(c, { ...emptyCtx, diagnosisCalls: [call(daysAgo(20), daysAgo(1) + 'T00:00:00Z')] }, today);
    expect(s.has('diag_followup_due')).toBe(false);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(false);
  });

  it('gives a diagnosis follow-up even with no onboard date', () => {
    const s = computeCustomerStatuses({ ...base, onboard_date: null }, { ...emptyCtx, diagnosisCalls: [call(daysAgo(20))] }, today);
    expect(s.has('diag_followup_due')).toBe(true);
  });

  it('still holds on an open support ticket when there is no diagnosis call', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [{ status: 'waiting_on_us', category: 'support' }] }, today);
    expect(s.has('fu_on_hold')).toBe(true);
  });
});
```
Add a `daysAhead` helper near `daysAgo` if not present:
```ts
const daysAhead = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) + 'T12:00:00Z'; };
```
And update `daysAgo` usages for calls to return a timestamp (the derivation parses with `new Date()`), e.g. ensure `daysAgo` returns an ISO date string — `new Date('2026-06-04')` parses fine. Keep `daysAgo` as-is (date-only string parses to UTC midnight).

Update the `STATUS_FILTERS` order test to 14 keys (insert `'diag_followup_due'` right after `'fu_on_hold'`):
```ts
    expect(STATUS_FILTERS.map(f => f.key)).toEqual([
      'overdue', 'due_today', 'due_7d', 'fu_on_hold', 'diag_followup_due', 'in_followup',
      'awaiting_onboarding', 'awaiting_response', 'awaiting_diagnosis', 'queued_replacement',
      'on_hold', 'awaiting_review', 'active', 'returned',
    ]);
```

- [ ] **Step 2: Run → fail.** `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: new cases fail.

- [ ] **Step 3: Implement.** In `app/src/lib/followupStatus.ts`:

(a) Add `'diag_followup_due'` to `FollowUpStatusKey` (after `'fu_on_hold'`) and to `STATUS_FILTERS` (after the `fu_on_hold` entry):
```ts
  { key: 'diag_followup_due',   label: 'Diagnosis follow-up due' },
```

(b) Extend `CustomerStatusContext`:
```ts
export type CustomerStatusContext = {
  openTickets: Pick<ServiceTicket, 'status' | 'category'>[];
  queuedReplacement: boolean;
  returned: boolean;
  awaitingOnboarding: boolean;
  diagnosisCalls: { startIso: string | null; followupDoneAt: string | null }[];
};
```

(c) Replace the current cadence/hold block (the `BLOCKING_TICKET_CATEGORIES` … `if (fuBlocked) { … } else { … }` section) with:
```ts
  // Diagnosis call (had or scheduled) supersedes the normal cadence. The
  // diagnosis follow-up is due 14 days after the call; once stamped done the
  // customer is resolved (normal FU does not resume).
  const DIAG_FOLLOWUP_DAYS = 14;
  const activeDiag = ctx.diagnosisCalls.filter(d => d.startIso && !d.followupDoneAt);
  const hasAnyDiag = ctx.diagnosisCalls.length > 0;
  const midToday = new Date(today); midToday.setHours(0, 0, 0, 0);
  const latestActiveStart = activeDiag
    .map(d => d.startIso as string)
    .sort()
    .at(-1);
  const diagDue = latestActiveStart != null
    && midToday.getTime() >= new Date(latestActiveStart).getTime() + DIAG_FOLLOWUP_DAYS * 86_400_000;

  const BLOCKING_TICKET_CATEGORIES = ['support', 'repair'];
  const blockingCondition =
    ctx.queuedReplacement
    || ctx.openTickets.some(t => BLOCKING_TICKET_CATEGORIES.includes(t.category as string));
  const pendingFu = !!c.onboard_date && fu !== 'complete' && fu !== 'unscheduled';

  if (hasAnyDiag) {
    if (activeDiag.length > 0) {
      if (diagDue) s.add('diag_followup_due');
      else s.add('fu_on_hold');
    }
    // all diagnosis follow-ups done → resolved: normal cadence stays suppressed
  } else if (pendingFu && blockingCondition) {
    s.add('fu_on_hold');
  } else {
    if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
    if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
    const dnext = daysToNextFu(c, today);
    if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');
    if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');
  }
```
Leave the rest of the function (ticket reason tags incl. `awaiting_diagnosis`, `awaiting_*`, `returned`, `active`) unchanged.

- [ ] **Step 4: Run → pass.** `cd app && npx vitest run src/lib/followupStatus.test.ts` (all pass), `npx tsc --noEmit` (clean — note: the hook in this same file passes `ctx` WITHOUT `diagnosisCalls` yet → tsc WILL error on the `useFollowUpDirectory` ctx object; that's fixed in Task 3. If tsc errors only there, proceed; otherwise fix). `npm run lint`.

  > Because `useFollowUpDirectory` (same file) builds the ctx, add `diagnosisCalls: []` there as a stopgap in THIS task so tsc/lint stay green, then Task 3 replaces it with the real mapping. Simplest: in Task 2 step 3, when editing, also add `diagnosisCalls: [],` to the ctx object in `useFollowUpDirectory` so the file compiles; Task 3 swaps in the real value.

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(followups): diagnosis call supersedes cadence; diag_followup_due status"
```

---

### Task 3: Hook feeds diagnosis calls

**Files:**
- Modify: `app/src/lib/followupStatus.ts` (the `useFollowUpDirectory` hook)

- [ ] **Step 1:** In `useFollowUpDirectory`, alongside the existing `ticketsByCustomer` build loop, add (does NOT skip closed tickets — diagnosis history matters):
```ts
    const diagnosisCallsByCustomer = new Map<string, { startIso: string | null; followupDoneAt: string | null }[]>();
    for (const t of tickets) {
      if (t.category !== 'diagnosis_call') continue;
      const cid = resolveCustomerId(t, idx);
      if (!cid) continue;
      const arr = diagnosisCallsByCustomer.get(cid);
      const entry = { startIso: t.calendly_event_start, followupDoneAt: t.diagnosis_followup_done_at };
      if (arr) arr.push(entry); else diagnosisCallsByCustomer.set(cid, [entry]);
    }
```

- [ ] **Step 2:** In the `customers.map(...)` ctx object, replace the stopgap `diagnosisCalls: []` with:
```ts
        diagnosisCalls: diagnosisCallsByCustomer.get(c.id) ?? [],
```

- [ ] **Step 3:** `cd app && npx tsc --noEmit` (clean now), `npm run lint` (exit 0), `npx vitest run src/lib/followupStatus.test.ts` (pass).

- [ ] **Step 4: Commit**
```bash
git add app/src/lib/followupStatus.ts
git commit -m "feat(followups): feed all diagnosis-call tickets into the directory derivation"
```

---

### Task 4: Calendar diagnosis-follow-up marker

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css`

- [ ] **Step 1:** In `FollowUpsTab.tsx`, extend the `FollowUpCalendar` `tickets` prop type to include the done stamp:
```ts
  tickets: { id: string; category: string; calendly_event_start: string | null; customer_name: string | null; subject: string; diagnosis_followup_done_at: string | null }[];
```
(The full `ServiceTicket[]` passed in already has the field after Task 1.)

- [ ] **Step 2:** Broaden the `CallEvent` kind to include the new marker. Find `callKind: 'onboarding' | 'diagnosis'` and add `| 'diag_followup'`.

- [ ] **Step 3:** In `eventsByDay`, after the diagnosis-call loop, add the diagnosis-follow-up markers (call start + 14 days):
```tsx
    for (const t of tickets) {
      if (t.category === 'diagnosis_call' && t.calendly_event_start && !t.diagnosis_followup_done_at) {
        const due = new Date(t.calendly_event_start);
        due.setDate(due.getDate() + 14);
        add(dayKey(due), {
          type: 'call', callKind: 'diag_followup',
          label: t.customer_name ?? t.subject, time: due.toISOString(), ticketId: t.id,
        });
      }
    }
```
(`dayKey` is defined in this file; confirm and reuse.)

- [ ] **Step 4:** In the call-event render branch, handle the new kind (icon 🩺→ use 🔁 for follow-up; class `calEventDiagFollowup`):
```tsx
                      className={`${styles.calEvent} ${ev.callKind === 'diag_followup' ? styles.calEventDiagFollowup : ev.callKind === 'diagnosis' ? styles.calEventDiagnosis : styles.calEventCall}`}
                      title={`${ev.callKind === 'diag_followup' ? 'Diagnosis follow-up' : ev.callKind === 'diagnosis' ? 'Diagnosis call' : 'Onboarding call'} — ${ev.label}`}>
                      {ev.callKind === 'diag_followup' ? '🔁' : ev.callKind === 'diagnosis' ? '🩺' : '🚀'} {ev.label}
```
Add a legend entry + CSS:
```css
.calEventDiagFollowup { background: #e6fffa; color: #234e52; border-left: 3px solid #319795; }
.calDotDiagFollowup { background: #319795; }
```
Legend item:
```tsx
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotDiagFollowup}`} /> Diagnosis follow-up
        </span>
```

- [ ] **Step 5:** `cd app && npx tsc --noEmit`, `npm run lint`, `npm run build` — all clean.

- [ ] **Step 6: Commit**
```bash
git add app/src/modules/Service/FollowUpsTab.tsx app/src/modules/Service/FollowUps.module.css
git commit -m "feat(followups): render diagnosis follow-up marker (call+14d) on the calendar"
```

---

### Task 5: "Mark diagnosis follow-up done" in `TicketDetailPanel`

**Files:**
- Modify: `app/src/modules/Service/TicketDetailPanel.tsx`

- [ ] **Step 1:** Add `markDiagnosisFollowupDone` to the existing `from '../../lib/service'` import (the line that imports `markDiagnosisLinkSent`).

- [ ] **Step 2:** Near the existing diagnosis-link block (`ticket.diagnosis_link_sent_at` UI), add a diagnosis-follow-up control shown only for `ticket.category === 'diagnosis_call'` with a `calendly_event_start`:
```tsx
          {ticket.category === 'diagnosis_call' && ticket.calendly_event_start && (
            ticket.diagnosis_followup_done_at ? (
              <span className={styles.replacementLink} title={ticket.diagnosis_followup_done_at}>
                Diagnosis follow-up done {new Date(ticket.diagnosis_followup_done_at).toLocaleDateString()}
              </span>
            ) : (
              <button
                type="button"
                className={styles.linkLike}
                title={`Due ${new Date(new Date(ticket.calendly_event_start).getTime() + 14 * 86_400_000).toLocaleDateString()}`}
                onClick={() => void markDiagnosisFollowupDone(ticket.id)}
              >
                Mark diagnosis follow-up done
              </button>
            )
          )}
```
(Use the same `styles.*` classes the neighbouring diagnosis-link UI uses — read the file and match; if `linkLike` doesn't exist there, reuse the class the "Send diagnosis link" button uses.)

- [ ] **Step 3:** `cd app && npx tsc --noEmit`, `npm run lint`, `npm run build` — clean.

- [ ] **Step 4: Commit**
```bash
git add app/src/modules/Service/TicketDetailPanel.tsx
git commit -m "feat(service): mark-diagnosis-follow-up-done action on diagnosis tickets"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `cd app && npm test` (all green), `npm run lint` (exit 0), `npm run build` (success).
- [ ] **Step 2:** `grep -rn "diag_followup_due\|diagnosisCalls\|diagnosis_followup_done_at" app/src` — confirm consistent usage and that `FollowUpDirectory` (maps `STATUS_FILTERS`) shows the new chip with no change.
- [ ] **Step 3:** Controller applies the migration to prod + pushes `main`.

---

## Self-review notes
- **Spec coverage:** §3.1 → Task 1; §3.2 → Task 2; §3.3 → Task 3; §3.4 → Task 4; §3.5 → Task 5; §6 testing → Tasks 2 & 6. Covered.
- **Type consistency:** `CustomerStatusContext.diagnosisCalls` shape `{startIso, followupDoneAt}` matches the hook's entries and tests; `diag_followup_due` added to union + STATUS_FILTERS + tests (14 keys); `diagnosis_followup_done_at` added to `ServiceTicket` and the calendar `tickets` prop shape.
- **Transient compile:** Task 2 adds a stopgap `diagnosisCalls: []` in the hook so the file compiles; Task 3 swaps in the real mapping. No broken build between commits.
- **No placeholders.** Lint gate in every task.
