# Follow-Up Hold & Reschedule on Ticket Close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Follow-Ups customer has any open support ticket, hold their pending onboarding follow-ups; once all tickets close, reschedule FU1 to close + 2 weeks and FU2 to close + 4 weeks.

**Architecture:** Pure, read-time derivation — no DB migration, cron, or edge function. Introduce an "effective follow-up anchor" (onboard_date, shifted to a later ticket-close date) that FU1/FU2 due dates count from, and thread it through the existing `computeFuState` / `computeCustomerStatuses` / calendar code.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest. Follow-Ups libs: `app/src/lib/customers.ts`, `app/src/lib/followupStatus.ts`. UI: `app/src/modules/Service/FollowUpsTab.tsx`, `FollowUpDetailPanel.tsx`.

Spec: `docs/superpowers/specs/2026-07-02-followup-reschedule-on-ticket-close-design.md`

**Working branch:** `feature/followup-reschedule-on-ticket-close` (already created). All commands run from `app/` unless noted. Run tests with `npx vitest run <file>`.

**Design decisions locked from the spec:**
- Any open ticket (any category) holds follow-ups (broadened from issue-only).
- Reschedule uses the most-recent closed ticket of any category.
- Anchor-shift semantics: `anchor = max(onboard_date, lastClosedAnyTicketAt)`; FU1 = anchor + 14d, FU2 = anchor + 28d. A completed touch stays done; only pending touches move.
- The separate issue-only post-close follow-up (`lastClosedTicket` / `post_close_followup_done_at`) is untouched.

---

## File Structure

- `app/src/lib/customers.ts` — add `followUpDueDates(anchorIso)`; add optional `anchorIso` param to `computeFuState`. (Modify)
- `app/src/lib/customers.test.ts` — tests for `followUpDueDates` + `computeFuState` anchor override. (Modify)
- `app/src/lib/followupStatus.ts` — add `lastClosedAnyTicketAt` to `CustomerStatusContext`; add `effectiveFollowUpAnchor`; thread anchor into `computeFuState`/`daysToNextFu`; broaden block condition; populate `lastClosedAnyTicketAt` + expose `anchorDate` on rows in `useFollowUpDirectory`. (Modify)
- `app/src/lib/followupStatus.test.ts` — tests for anchor, reschedule, partial completion, any-open-ticket hold. (Modify)
- `app/src/modules/Service/FollowUpsTab.tsx` — position FU1/FU2 calendar markers from the effective anchor. (Modify)

---

## Task 1: Anchor-aware due dates in `customers.ts`

**Files:**
- Modify: `app/src/lib/customers.ts` (`computeFuState`, near lines 120-143)
- Test: `app/src/lib/customers.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/customers.test.ts` (add `followUpDueDates` to the existing import from `./customers`; if the file has no import for these yet, add `import { computeFuState, followUpDueDates } from './customers';` and reuse any existing `base` Customer fixture — if none exists in this file, copy the `base` object from `followupStatus.test.ts`):

```ts
describe('followUpDueDates', () => {
  it('returns FU1 at +14d and FU2 at +28d from the anchor', () => {
    const { fu1Due, fu2Due } = followUpDueDates('2026-06-01');
    expect(fu1Due.toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(fu2Due.toISOString().slice(0, 10)).toBe('2026-06-29');
  });
});

describe('computeFuState anchor override', () => {
  const today = new Date('2026-07-01T12:00:00');
  it('uses onboard_date when no anchor is passed', () => {
    const c = { ...base, onboard_date: '2026-05-01' }; // FU1 due 05-15 → overdue by 07-01
    expect(computeFuState(c, today)).toBe('overdue_fu1');
  });
  it('uses the anchor override instead of onboard_date', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    // Anchor 06-25 → FU1 due 07-09 → still upcoming on 07-01
    expect(computeFuState(c, today, '2026-06-25')).toBe('upcoming_fu1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/customers.test.ts`
Expected: FAIL — `followUpDueDates is not a function` and the anchor-override test fails.

- [ ] **Step 3: Implement**

In `app/src/lib/customers.ts`, replace the `computeFuState` function (currently lines ~123-143) with:

```ts
/** FU1/FU2 due dates computed from an anchor date (ISO `YYYY-MM-DD`). */
export function followUpDueDates(anchorIso: string): { fu1Due: Date; fu2Due: Date } {
  const anchor = new Date(anchorIso.slice(0, 10) + 'T00:00:00');
  const fu1Due = new Date(anchor); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
  const fu2Due = new Date(anchor); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
  return { fu1Due, fu2Due };
}

/** Compute the follow-up state for a customer. Due dates count from `anchorIso`
 *  when supplied (the effective anchor after a ticket-close reschedule),
 *  otherwise from `onboard_date`. "Today" = same calendar day. */
export function computeFuState(c: Customer, today: Date = new Date(), anchorIso?: string | null): FuState {
  if (!c.onboard_date) return 'unscheduled';
  const { fu1Due, fu2Due } = followUpDueDates(anchorIso ?? c.onboard_date);
  const todayMid = new Date(today); todayMid.setHours(0, 0, 0, 0);

  if (c.fu1_status && c.fu2_status) return 'complete';

  if (!c.fu1_status) {
    if (todayMid > fu1Due) return 'overdue_fu1';
    if (todayMid.getTime() === fu1Due.getTime()) return 'due_fu1';
    return 'upcoming_fu1';
  }
  // fu1 done, fu2 pending
  if (todayMid > fu2Due) return 'overdue_fu2';
  if (todayMid.getTime() === fu2Due.getTime()) return 'due_fu2';
  return 'upcoming_fu2';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/customers.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/lib/customers.ts app/src/lib/customers.test.ts
git commit -m "feat(follow-ups): anchor-aware FU due dates (followUpDueDates + computeFuState override)"
```

---

## Task 2: `effectiveFollowUpAnchor` + context field in `followupStatus.ts`

**Files:**
- Modify: `app/src/lib/followupStatus.ts` (`CustomerStatusContext` ~lines 32-41; add helper near `ticketFollowupDueDate`)
- Test: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/followupStatus.test.ts`. Update the import to include `effectiveFollowUpAnchor` from `./followupStatus`:

```ts
describe('effectiveFollowUpAnchor', () => {
  it('returns null when onboard_date is null', () => {
    expect(effectiveFollowUpAnchor({ ...base }, emptyCtx)).toBeNull();
  });
  it('returns onboard_date when there is no closed ticket', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    expect(effectiveFollowUpAnchor(c, emptyCtx)).toBe('2026-05-01');
  });
  it('shifts the anchor to a ticket that closed after onboarding', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: '2026-06-10T09:30:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-06-10');
  });
  it('keeps onboard_date when the closed ticket predates onboarding', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: '2026-04-01T00:00:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-05-01');
  });
  it('keeps the base anchor while a ticket is still open', () => {
    const c = { ...base, onboard_date: '2026-05-01' };
    const ctx = { ...emptyCtx, openTickets: [{ status: 'in_progress', category: 'support' }], lastClosedAnyTicketAt: '2026-06-10T00:00:00Z' };
    expect(effectiveFollowUpAnchor(c, ctx)).toBe('2026-05-01');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/followupStatus.test.ts`
Expected: FAIL — `effectiveFollowUpAnchor is not a function`.

- [ ] **Step 3: Implement**

In `app/src/lib/followupStatus.ts`:

(a) Add `lastClosedAnyTicketAt` to the `CustomerStatusContext` type (after the existing `lastClosedTicket` field, ~line 40):

```ts
  // Most-recent close date (ISO timestamp) across ALL ticket categories — not
  // just issue tickets. Anchors the FU1/FU2 reschedule once a hold lifts.
  // Distinct from lastClosedTicket, which is issue-only and drives the separate
  // post-close ticket follow-up.
  lastClosedAnyTicketAt?: string | null;
```

(b) Update the import from `./customers` at the top of the file to also pull `followUpDueDates`:

```ts
import { useCustomers, computeFuState, followUpDueDates, FU1_DAYS, FU2_DAYS, type FuState, type Customer } from './customers';
```

(c) Add the helper (place it just after `ticketFollowupDueDate`, ~line 61):

```ts
/** The date FU1/FU2 count from: `onboard_date`, shifted forward to a later
 *  ticket-close date when the customer had a blocking ticket that has since
 *  closed. Returns ISO `YYYY-MM-DD`, or null when unscheduled. */
export function effectiveFollowUpAnchor(c: Customer, ctx: CustomerStatusContext): string | null {
  if (!c.onboard_date) return null;
  // While any ticket is open the customer is on hold; the anchor isn't surfaced.
  if (ctx.openTickets.length > 0) return c.onboard_date;
  const closed = ctx.lastClosedAnyTicketAt?.slice(0, 10);
  if (closed && closed > c.onboard_date) return closed;
  return c.onboard_date;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/followupStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(follow-ups): effectiveFollowUpAnchor + lastClosedAnyTicketAt context"
```

---

## Task 3: Wire anchor + broaden block condition in `computeCustomerStatuses`

**Files:**
- Modify: `app/src/lib/followupStatus.ts` (`daysToNextFu` ~lines 63-74; `computeCustomerStatuses` ~lines 77-140)
- Test: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/followupStatus.test.ts` (the file already has `today = new Date('2026-06-18T12:00:00')` and `daysAgo`/`daysAhead` helpers — reuse them):

```ts
describe('follow-up hold + reschedule on ticket close', () => {
  const openT = (category = 'support') => ({ status: 'in_progress', category });

  it('holds pending FU while ANY open ticket exists (incl. non-issue categories)', () => {
    const c = { ...base, onboard_date: daysAgo(20) }; // FU1 overdue by onboard math
    const ctx = { ...emptyCtx, openTickets: [openT('onboarding')] };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('fu_on_hold')).toBe(true);
    expect(s.has('overdue')).toBe(false);
  });

  it('reschedules FU1 to close+14d after all tickets close', () => {
    const c = { ...base, onboard_date: daysAgo(40) }; // long overdue by onboard math
    // Ticket closed 5 days ago → FU1 due close+14 → 9 days out → not overdue/not due_today
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(5) + 'T00:00:00Z' };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('due_today')).toBe(false);
    expect(s.has('in_followup')).toBe(true);
  });

  it('marks FU1 due_today exactly 14 days after close', () => {
    const c = { ...base, onboard_date: daysAgo(40) };
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(14) + 'T00:00:00Z' };
    expect(computeCustomerStatuses(c, ctx, today).has('due_today')).toBe(true);
  });

  it('reschedules only the pending touch (FU1 done → FU2 at close+28d)', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called' };
    // Closed 10 days ago → FU2 due close+28 → 18 days out → upcoming, not due_7d
    const ctx = { ...emptyCtx, lastClosedAnyTicketAt: daysAgo(10) + 'T00:00:00Z' };
    const s = computeCustomerStatuses(c, ctx, today);
    expect(s.has('overdue')).toBe(false);
    expect(s.has('due_7d')).toBe(false);
    expect(s.has('in_followup')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/followupStatus.test.ts`
Expected: FAIL — the reschedule tests still see onboard-based overdue; the any-open hold test may already pass or fail depending on category.

- [ ] **Step 3: Implement**

In `app/src/lib/followupStatus.ts`:

(a) Give `daysToNextFu` an anchor param (replace the function, ~lines 63-74):

```ts
/** Days until the customer's next still-pending follow-up, or null if none
 *  pending (unscheduled or both complete). Negative = overdue. Counts from
 *  `anchorIso` when given, otherwise `onboard_date`. */
function daysToNextFu(c: Customer, today: Date, anchorIso?: string | null): number | null {
  if (!c.onboard_date) return null;
  const { fu1Due, fu2Due } = followUpDueDates(anchorIso ?? c.onboard_date);
  const mid = new Date(today); mid.setHours(0, 0, 0, 0);
  const dayDiff = (d: Date) => Math.round((d.getTime() - mid.getTime()) / 86_400_000);
  if (!c.fu1_status) return dayDiff(fu1Due);
  if (!c.fu2_status) return dayDiff(fu2Due);
  return null;
}
```

(b) In `computeCustomerStatuses`, compute the anchor and use it. Replace the line `const fu = computeFuState(c, today);` (~line 81) with:

```ts
  const anchor = effectiveFollowUpAnchor(c, ctx);
  const fu = computeFuState(c, today, anchor);
```

(c) Broaden the block condition. Replace `const blockingCondition = ctx.queuedReplacement || openIssueTickets.length > 0;` (~line 99) with:

```ts
  // Any open ticket (any category) holds a pending follow-up — not just issue
  // tickets. openIssueTickets is still used below for the post-close follow-up.
  const blockingCondition = ctx.queuedReplacement || ctx.openTickets.length > 0;
```

(d) Pass the anchor into the `daysToNextFu` call inside the `else` branch. Replace `const dnext = daysToNextFu(c, today);` (~line 113) with:

```ts
    const dnext = daysToNextFu(c, today, anchor);
```

Leave the `openIssueTickets` declaration and the post-close `ticket_followup_due` block (which uses `openIssueTickets.length === 0` and `ctx.lastClosedTicket`) unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/followupStatus.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(follow-ups): hold on any open ticket + reschedule FU1/FU2 from close date"
```

---

## Task 4: Populate `lastClosedAnyTicketAt` + expose `anchorDate` on rows

**Files:**
- Modify: `app/src/lib/followupStatus.ts` (`DirectoryRow` type ~line 176; `useFollowUpDirectory` ~lines 231-309)

This wires the pure logic into the live hook. It's covered by the type-check and the full test run rather than a new unit test (the hook depends on Supabase hooks).

- [ ] **Step 1: Add `anchorDate` to the `DirectoryRow` type**

Replace the `DirectoryRow` type (~lines 176-180) with:

```ts
export type DirectoryRow = {
  customer: Customer;
  statuses: Set<FollowUpStatusKey>;
  fuState: FuState;
  // Effective FU anchor (onboard_date, shifted after a ticket-close reschedule),
  // ISO YYYY-MM-DD or null. Used by the calendar to place FU1/FU2 markers.
  anchorDate: string | null;
};
```

- [ ] **Step 2: Track the most-recent closed ticket of any category**

Inside `useFollowUpDirectory`'s `useMemo`, add a map next to `lastClosedByCustomer` (~line 235):

```ts
    // Most-recent close (ISO) across ALL categories — anchors the FU reschedule.
    const lastClosedAnyByCustomer = new Map<string, string>();
```

In the ticket loop, inside the `if (t.status === 'closed') {` block, add these two lines **before** the `if (!isIssueTicket(t)) continue;` line (~line 240):

```ts
        if (t.closed_at) {
          const prevAny = lastClosedAnyByCustomer.get(cid);
          if (!prevAny || t.closed_at > prevAny) lastClosedAnyByCustomer.set(cid, t.closed_at);
        }
```

- [ ] **Step 3: Put it in the context and store the anchor on the row**

In the per-customer loop, add to the `ctx` object literal (~line 285, after `lastClosedTicket,`):

```ts
        lastClosedAnyTicketAt: lastClosedAnyByCustomer.get(c.id) ?? null,
```

Then replace the `rows.push(...)` line (~line 293) with:

```ts
      const anchorDate = effectiveFollowUpAnchor(c, ctx);
      rows.push({ customer: c, statuses, fuState: computeFuState(c, today, anchorDate), anchorDate });
```

- [ ] **Step 4: Type-check + full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/lib/followupStatus.ts
git commit -m "feat(follow-ups): surface effective anchor + any-category close in directory hook"
```

---

## Task 5: Re-anchor FU1/FU2 markers on the calendar

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx` (calendar props ~lines 28-36; marker loop ~lines 96-110; `FollowUpsTab` render ~lines 283-290)

- [ ] **Step 1: Pass a per-customer anchor map into the calendar**

In `FollowUpsTab` (the exported component, ~line 214), after `blockedCustomerIds` is built (~line 237), add:

```ts
  const anchorByCustomer = useMemo(
    () => new Map(rows.map(r => [r.customer.id, r.anchorDate])),
    [rows],
  );
```

In the `<FollowUpCalendar ... />` JSX (~line 283), add the prop:

```tsx
            anchorByCustomer={anchorByCustomer}
```

- [ ] **Step 2: Accept the prop in `FollowUpCalendar`**

In the `FollowUpCalendar` function signature/props (~lines 28-36), add `anchorByCustomer` to both the destructure and the props type:

```tsx
function FollowUpCalendar({
  month, today, customers, tickets, ticketFollowups, blockedCustomerIds, anchorByCustomer, onPrev, onNext, onToday, onCustomerClick, onCallClick,
```

and in the props type object add:

```ts
  anchorByCustomer: Map<string, string | null>;
```

- [ ] **Step 3: Use the anchor for FU marker positions**

Update the import from `../../lib/customers` at the top of the file to include `followUpDueDates` (it already imports `computeFuState`, `FU1_DAYS`, `FU2_DAYS`).

Replace the follow-up marker loop (~lines 96-109) with:

```tsx
    for (const c of customers) {
      if (!c.onboard_date) continue;
      if (blockedCustomerIds.has(c.id)) continue; // follow-up on hold — skip FU markers
      const anchor = anchorByCustomer.get(c.id) ?? c.onboard_date;
      const { fu1Due: fu1, fu2Due: fu2 } = followUpDueDates(anchor);
      const state = computeFuState(c, today, anchor);
      for (const [kind, dueDate] of [['fu1', fu1], ['fu2', fu2]] as const) {
        if (dueDate < gridStart || dueDate >= gridEnd) continue;
        if (kind === 'fu1' && c.fu1_status) continue;
        if (kind === 'fu2' && !c.fu1_status) continue;
        if (kind === 'fu2' && c.fu2_status) continue;
        add(dayKey(dueDate), { type: 'fu', customer: c, kind, dueDate, state });
      }
    }
```

Add `anchorByCustomer` to the `useMemo` dependency array of that memo (~line 112): change `[customers, tickets, ticketFollowups, blockedCustomerIds, today, gridStart, gridEnd]` to `[customers, tickets, ticketFollowups, blockedCustomerIds, anchorByCustomer, today, gridStart, gridEnd]`.

- [ ] **Step 4: Type-check + full test run**

Run (from `app/`): `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/modules/Service/FollowUpsTab.tsx
git commit -m "feat(follow-ups): position FU1/FU2 calendar markers from the effective anchor"
```

---

## Task 6: Verify detail panel + final build

**Files:**
- Read-only check: `app/src/modules/Service/FollowUpDetailPanel.tsx`

- [ ] **Step 1: Confirm the detail panel needs no change**

The pause banner copy at `FollowUpDetailPanel.tsx:126-131` already reads "They'll auto-reschedule to 14/28 days after the ticket close date" — no copy change needed. Grep to confirm the panel derives FU due dates through `computeFuState` / directory rows rather than hard-coding `onboard_date + 14/28`:

Run (from `app/`): `grep -n "FU1_DAYS\|FU2_DAYS\|onboard_date" src/modules/Service/FollowUpDetailPanel.tsx`
Expected: no hard-coded FU1/FU2 date math that bypasses `computeFuState`. If any is found, re-anchor it the same way as Task 5 (use the row's `anchorDate`); otherwise no change.

- [ ] **Step 2: Production build**

Run (from `app/`): `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 3: Manual verification (record result)**

With `npm run dev`, in Service → Follow-Ups: pick a customer with a set `onboard_date` and create/close a support ticket. Confirm (a) while the ticket is open the customer shows `fu_on_hold` and no FU markers on the calendar; (b) after closing the ticket, FU1 appears on the calendar at close + 14 days and FU2 at close + 28 days; (c) a customer whose FU1 was already done shows only FU2, at close + 28 days.

- [ ] **Step 4: Commit any Task-6 fixes (if Step 1 required a change)**

```bash
cd .. && git add -A && git commit -m "fix(follow-ups): re-anchor FU due dates in detail panel"
```

(Skip if Step 1 required no change.)

---

## Self-Review notes

- **Spec coverage:** hold-on-any-open-ticket (Task 3c) ✓; reschedule FU1=close+14 / FU2=close+28 (Tasks 1-3) ✓; reschedule-only-pending (Task 3 partial test) ✓; multiple tickets → latest close (Task 4 max over closed_at) ✓; calendar + detail-panel surfaces (Tasks 5-6) ✓; post-close follow-up untouched (openIssueTickets/lastClosedTicket left intact) ✓; no migration/cron (derived only) ✓.
- **Type consistency:** `followUpDueDates` returns `{ fu1Due, fu2Due }` (used in Tasks 1, 3, 5); `effectiveFollowUpAnchor(c, ctx)` returns `string | null` (Tasks 2, 4, 5); `lastClosedAnyTicketAt` on context and `anchorDate` on `DirectoryRow` (Tasks 2, 4, 5) — names consistent across tasks.
- **Behavior change to flag in review:** broadening the hold to any open ticket category (Task 3c) — documented in the spec.
