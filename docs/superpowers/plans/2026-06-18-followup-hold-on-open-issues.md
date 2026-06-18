# Hold Follow-Ups on Open Replacement/Ticket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a customer's follow-up on hold (status `fu_on_hold`, removed from overdue queue + calendar markers) while they have a queued replacement or an open support/repair/diagnosis ticket; resume automatically when resolved.

**Architecture:** Add a blocking gate to the pure `computeCustomerStatuses` (suppress cadence statuses, emit `fu_on_hold`); the overdue send-queue already keys off `overdue ∪ due_today` so blocked customers drop out automatically; pass a `blockedCustomerIds` set into `FollowUpCalendar` to skip their FU markers.

**Tech Stack:** React 18 + TS, CSS Modules, Vitest. Spec: `docs/superpowers/specs/2026-06-18-followup-hold-on-open-issues-design.md`. **The Pages deploy runs `npm run lint` (eslint, exit 1 on any error) before build — lint MUST be clean.** Work directly on `main`; each task must leave lint+build green.

---

### Task 1: Blocking gate + `fu_on_hold` status (pure derivation, TDD)

**Files:**
- Modify: `app/src/lib/followupStatus.ts`
- Modify: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Add failing tests.** Append to `app/src/lib/followupStatus.test.ts` (the file already defines `base: Customer`, `emptyCtx`, `today`, `daysAgo`):

```ts
describe('follow-up hold on open issues', () => {
  const ticket = (category: ServiceTicket['category'], status: ServiceTicket['status'] = 'waiting_on_us') =>
    ({ status, category });

  it('holds FU when a replacement is queued (suppresses overdue, adds fu_on_hold)', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // would be FU1 overdue
    const s = computeCustomerStatuses(c, { ...emptyCtx, queuedReplacement: true }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('in_followup')).toBe(false);
    expect(s.has('queued_replacement')).toBe(true);
  });

  it('holds FU when an open support ticket exists', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support')] }, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
  });

  it('holds FU for an open repair or diagnosis ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('repair')] }, today).has('fu_on_hold')).toBe(true);
    expect(computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('diagnosis_call')] }, today).has('fu_on_hold')).toBe(true);
  });

  it('does NOT hold FU for an onboarding-category ticket', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('onboarding')] }, today);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(true);
  });

  it('does NOT mark fu_on_hold when the follow-up is already complete', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called', fu2_status: 'called' };
    const s = computeCustomerStatuses(c, { ...emptyCtx, openTickets: [ticket('support')] }, today);
    expect(s.has('fu_on_hold')).toBe(false);
  });

  it('does NOT mark fu_on_hold for an unscheduled customer (no onboard date)', () => {
    const s = computeCustomerStatuses({ ...base, onboard_date: null }, { ...emptyCtx, queuedReplacement: true }, today);
    expect(s.has('fu_on_hold')).toBe(false);
  });

  it('auto-resumes: no blocking condition → overdue returns', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('fu_on_hold')).toBe(false);
    expect(s.has('overdue')).toBe(true);
  });
});
```

Also update the existing `STATUS_FILTERS covers all ... keys in display order` test to the new 13-key list (insert `'fu_on_hold'` right after `'due_7d'`):
```ts
    expect(STATUS_FILTERS.map(f => f.key)).toEqual([
      'overdue', 'due_today', 'due_7d', 'fu_on_hold', 'in_followup', 'awaiting_onboarding',
      'awaiting_response', 'awaiting_diagnosis', 'queued_replacement',
      'on_hold', 'awaiting_review', 'active', 'returned',
    ]);
```

- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: new cases FAIL (`fu_on_hold` not a member / not emitted).

- [ ] **Step 3: Implement.** In `app/src/lib/followupStatus.ts`:

(a) Add `'fu_on_hold'` to the `FollowUpStatusKey` union:
```ts
export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d' | 'fu_on_hold'
  | 'in_followup' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'queued_replacement' | 'on_hold'
  | 'awaiting_review' | 'active' | 'returned';
```

(b) Add to `STATUS_FILTERS` immediately after the `due_7d` entry:
```ts
  { key: 'fu_on_hold',          label: 'Follow-up on hold' },
```

(c) In `computeCustomerStatuses`, replace the current cadence block:
```ts
  if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
  if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
  const dnext = daysToNextFu(c, today);
  if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');

  if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');
```
with:
```ts
  // A pending follow-up is put ON HOLD while the customer has an unresolved
  // issue — a queued replacement or an open support/repair/diagnosis ticket.
  // Onboarding-call tickets don't block. Resumes automatically once resolved.
  const BLOCKING_TICKET_CATEGORIES = ['support', 'repair', 'diagnosis_call'];
  const blockingCondition =
    ctx.queuedReplacement
    || ctx.openTickets.some(t => BLOCKING_TICKET_CATEGORIES.includes(t.category as string));
  const pendingFu = !!c.onboard_date && fu !== 'complete' && fu !== 'unscheduled';
  const fuBlocked = pendingFu && blockingCondition;

  if (fuBlocked) {
    s.add('fu_on_hold');
  } else {
    if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
    if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
    const dnext = daysToNextFu(c, today);
    if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');
    if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');
  }
```
Leave the rest of the function (ticket reason tags, awaiting_*, returned, active) unchanged.

- [ ] **Step 4: Run to verify pass** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: all PASS. Then `cd app && npx tsc --noEmit` (clean) and `cd app && npm run lint` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(followups): hold follow-ups while a replacement/ticket is open"
```

---

### Task 2: Suppress FU calendar markers for blocked customers

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`

- [ ] **Step 1: Read** `app/src/modules/Service/FollowUpsTab.tsx` to locate (a) the `FollowUpCalendar` component's props type + its `eventsByDay` FU loop `for (const c of customers) { if (!c.onboard_date) continue; ... }`, and (b) the `FollowUpsTab` component where `useFollowUpDirectory` rows are available and where `<FollowUpCalendar .../>` is rendered.

- [ ] **Step 2: Add the prop to `FollowUpCalendar`.** In its props type add:
```tsx
  blockedCustomerIds: Set<string>;
```
Add `blockedCustomerIds` to the destructured params. In the FU-event loop, right after the `if (!c.onboard_date) continue;` line, add:
```tsx
      if (blockedCustomerIds.has(c.id)) continue; // follow-up on hold — skip FU markers
```
(Do not touch the onboarding-call or diagnosis-call loops.)

- [ ] **Step 3: Compute + pass the set in `FollowUpsTab`.** Where `rows` from `useFollowUpDirectory` are in scope, add:
```tsx
  const blockedCustomerIds = useMemo(
    () => new Set(rows.filter(r => r.statuses.has('fu_on_hold')).map(r => r.customer.id)),
    [rows],
  );
```
Pass it to the calendar:
```tsx
        <FollowUpCalendar
          /* ...existing props unchanged... */
          blockedCustomerIds={blockedCustomerIds}
        />
```
(`useMemo` is already imported in this file.)

- [ ] **Step 4: Verify** — `cd app && npx tsc --noEmit` (clean), `cd app && npm run lint` (exit 0), `cd app && npm run build` (success), `cd app && npx vitest run src/lib/followupStatus.test.ts` (pass).

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Service/FollowUpsTab.tsx
git commit -m "feat(followups): suppress calendar FU markers for on-hold customers"
```

---

### Task 3: Full verification

- [ ] **Step 1:** `cd app && npm test` → all green (incl. new derivation cases).
- [ ] **Step 2:** `cd app && npm run lint` → exit 0; `cd app && npm run build` → success.
- [ ] **Step 3:** Confirm no other consumer breaks on the new key — `grep -rn "STATUS_FILTERS\|FollowUpStatusKey\|fu_on_hold" app/src` and eyeball that `FollowUpDirectory` (which maps `STATUS_FILTERS`) renders the new chip without code change (it iterates the array generically).

---

## Self-review notes
- **Spec coverage:** §3.1 gate + §3.2 key → Task 1; §3.3 send-queue (no change, verified) → Task 1 tests confirm overdue suppressed; §3.4 calendar → Task 2; §6 testing → Tasks 1 & 3. Covered.
- **Type consistency:** `fu_on_hold` added to the union + `STATUS_FILTERS` + tests; `blockedCustomerIds: Set<string>` consistent between `FollowUpCalendar` prop and `FollowUpsTab` computation.
- **No placeholders.** Lint gate in every task.
- **Directory chip:** `FollowUpDirectory` renders chips by mapping `STATUS_FILTERS`, so the new chip + count appear with no change there (Task 3 verifies).
