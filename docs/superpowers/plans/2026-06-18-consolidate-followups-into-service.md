# Consolidate Follow-Up Workflows into Service → Follow-Ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Service → Follow-Ups the single home for follow-ups: move the overdue draft+send panel there, make Service tabs deep-linkable, and strip the duplicate follow-up UI out of the Customers module (leaving a link).

**Architecture:** Relocate `OverdueFollowupPanel` (+ test + its CSS classes) from Customers into Service; mount it atop `FollowUpsTab` fed by the existing `useFollowUpDirectory` hook; add a `?tab=` query-param to `Service/index.tsx` (via `useSearchParams`, like `OrderReview`); delete FU filters/column/section from `Customers/index.tsx` and add a Router `Link` to `/service?tab=followups`.

**Tech Stack:** React 18 + TS, react-router-dom, CSS Modules, Vitest. Spec: `docs/superpowers/specs/2026-06-18-consolidate-followups-into-service-design.md`. **The Pages deploy runs `npm run lint` (eslint, exit 1 on any error) before build — lint MUST be clean.**

---

### Task 1: Make Service tabs deep-linkable via `?tab=`

**Files:**
- Modify: `app/src/modules/Service/index.tsx`
- Test: `app/src/modules/Service/__tests__/serviceTabParam.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import Service from '../index';

// The tab components hit supabase on mount; stub them to isolate tab routing.
vi.mock('../FollowUpsTab', () => ({ FollowUpsTab: () => <div>FOLLOWUPS_TAB</div> }));
vi.mock('../OnboardingTab', () => ({ OnboardingTab: () => <div>ONBOARDING_TAB</div> }));
vi.mock('../SupportTab', () => ({ SupportTab: () => <div>SUPPORT_TAB</div> }));
vi.mock('../InboxTab', () => ({ InboxTab: () => <div>INBOX_TAB</div> }));
vi.mock('../ReplacementTab', () => ({ default: () => <div>REPLACEMENT_TAB</div> }));

describe('Service tab deep-linking', () => {
  it('opens the Follow-Ups tab when ?tab=followups', () => {
    render(<MemoryRouter initialEntries={['/service?tab=followups']}><Service /></MemoryRouter>);
    expect(screen.getByText('FOLLOWUPS_TAB')).toBeInTheDocument();
  });
  it('defaults to onboarding with no/unknown tab', () => {
    render(<MemoryRouter initialEntries={['/service?tab=bogus']}><Service /></MemoryRouter>);
    expect(screen.getByText('ONBOARDING_TAB')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd app && npx vitest run src/modules/Service/__tests__/serviceTabParam.test.tsx`. Expected: FAIL (tab not driven by URL).

- [ ] **Step 3: Implement.** In `app/src/modules/Service/index.tsx`:

Change the import line `import { useState } from 'react';` to:
```tsx
import { useSearchParams } from 'react-router-dom';
```
(Remove `useState` if no longer used elsewhere in the file; keep it if other state remains.)

Replace the `const [tab, setTab] = useState<Tab>('onboarding');` line with:
```tsx
  const [searchParams, setSearchParams] = useSearchParams();
  const TAB_KEYS: Tab[] = ['inbox', 'onboarding', 'support', 'replacement', 'followups'];
  const paramTab = searchParams.get('tab');
  const tab: Tab = (TAB_KEYS as string[]).includes(paramTab ?? '') ? (paramTab as Tab) : 'onboarding';
  const setTab = (next: Tab) => setSearchParams(prev => { prev.set('tab', next); return prev; }, { replace: true });
```

Leave the rest (`TABS.map`, the desktop `onClick={() => setTab(t.key)}`, and the mobile `MobileTabbedModule`) unchanged — they already call `setTab`/read `tab`. For the mobile branch, ensure it uses the same `tab`/`setTab` (if the mobile branch had its own `useState`, point it at these too).

- [ ] **Step 4: Run to verify it passes** — `cd app && npx vitest run src/modules/Service/__tests__/serviceTabParam.test.tsx`. Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd app && npm run lint && cd ..
git add app/src/modules/Service/index.tsx app/src/modules/Service/__tests__/serviceTabParam.test.tsx
git commit -m "feat(service): deep-link tabs via ?tab= query param"
```

---

### Task 2: Relocate `OverdueFollowupPanel` (component + test + CSS) into Service

**Files:**
- Move: `app/src/modules/Customers/OverdueFollowupPanel.tsx` → `app/src/modules/Service/OverdueFollowupPanel.tsx`
- Move: `app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx` → `app/src/modules/Service/__tests__/OverdueFollowupPanel.test.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css` (receive classes)
- Modify: `app/src/modules/Customers/Customers.module.css` (remove moved classes)

- [ ] **Step 1: Move the files with git**

```bash
cd /Users/reinageorge/Desktop/VCycene/Claude/Lovely/makelila
git mv app/src/modules/Customers/OverdueFollowupPanel.tsx app/src/modules/Service/OverdueFollowupPanel.tsx
git mv app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx app/src/modules/Service/__tests__/OverdueFollowupPanel.test.tsx
```

- [ ] **Step 2: Move the CSS classes.** These 15 classes are used by the panel — cut each block from `app/src/modules/Customers/Customers.module.css` and paste into the end of `app/src/modules/Service/FollowUps.module.css`:
`followupPanel`, `followupHeader`, `followupHint`, `followupError`, `followupList`, `draftCard`, `draftHeader`, `draftContext`, `draftPrimary`, `draftTextarea`, `draftCannedPicker`, `draftActions`, `draftSending`, `draftSent`, `draftSkipped`.
(Use `grep -n` for each class name in Customers.module.css to find its block; move the full `.name { … }` rule. If any class is also used elsewhere in Customers, copy instead of cut — verify with `grep -rn "styles.<name>" app/src/modules/Customers`.)

- [ ] **Step 3: Repoint imports in the moved component.** In `app/src/modules/Service/OverdueFollowupPanel.tsx`:
- `import styles from './Customers.module.css';` → `import styles from './FollowUps.module.css';`
- The `../../lib/customers` and `../../lib/cannedSms` imports stay correct (same depth). Leave them.

- [ ] **Step 4: Fix the moved test's import paths.** In `app/src/modules/Service/__tests__/OverdueFollowupPanel.test.tsx`, update the import of the component to `../OverdueFollowupPanel` (it already is `../OverdueFollowupPanel` after the move — verify) and any `../../../lib` paths (depth unchanged, should be fine). Run it.

- [ ] **Step 5: Run the moved test + lint** — `cd app && npx vitest run src/modules/Service/__tests__/OverdueFollowupPanel.test.tsx && npm run lint`. Expected: PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(followups): relocate OverdueFollowupPanel + its CSS into Service"
```

---

### Task 3: Mount the panel atop `FollowUpsTab`

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`

- [ ] **Step 1: Add the import + derive overdue IDs.** In `FollowUpsTab.tsx`, add:
```tsx
import { OverdueFollowupPanel } from './OverdueFollowupPanel';
```
Inside the component (it already calls `const { rows, counts, overdueCount } = useFollowUpDirectory(today);`), add below that:
```tsx
  // Overdue draft+send queue: customers needing action (overdue or due today),
  // most-overdue first (oldest onboard date). Mirrors the set the panel was
  // fed from the Customers tab.
  const overdueCustomerIds = useMemo(
    () => rows
      .filter(r => r.statuses.has('overdue') || r.statuses.has('due_today'))
      .sort((a, b) =>
        Number(b.statuses.has('overdue')) - Number(a.statuses.has('overdue'))
        || (a.customer.onboard_date ?? '').localeCompare(b.customer.onboard_date ?? ''))
      .map(r => r.customer.id),
    [rows],
  );
```
(Ensure `useMemo` is imported from 'react' — it already is in this file.)

- [ ] **Step 2: Render the panel** at the very top of the returned layout — inside the top-level `<div className={styles.wrap}>`, BEFORE the `layoutSplit/layoutStack` container:
```tsx
      <OverdueFollowupPanel
        overdueCount={overdueCustomerIds.length}
        overdueCustomerIds={overdueCustomerIds}
      />
```
(The panel returns `null` when `overdueCount === 0`, so it self-hides.)

- [ ] **Step 3: Typecheck + build + lint** — `cd app && npx tsc --noEmit && npm run lint && npm run build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/FollowUpsTab.tsx
git commit -m "feat(followups): mount overdue draft+send panel in the Follow-Ups tab"
```

---

### Task 4: Strip follow-up UI from the Customers module + add link

**Files:**
- Modify: `app/src/modules/Customers/index.tsx`

- [ ] **Step 1: Remove the FU code.** In `app/src/modules/Customers/index.tsx`, delete:
  - The `import { OverdueFollowupPanel } from './OverdueFollowupPanel';` line (component now lives in Service).
  - The `<OverdueFollowupPanel ... />` mount (~line 364) and the `overdueIds` `useMemo` (~lines 78-88).
  - `fuFilter` state (~line 61), the `fuCounts` `useMemo` (~lines 89-101), and the FU branches inside the list filter/sort `useMemo` (the `if (fuFilter ...)` blocks ~lines 104-126) — leave the country/search filtering intact.
  - The FU filter chip buttons block in the filter bar (the `Any FU` / `Needs action` / `FU1 overdue` / `FU2 overdue` buttons, ~lines 378-395) and the leading `filterDivider` if it only separated those.
  - The `<th>Follow-up</th>` header (~line 416) and the matching `<td>` cell that renders the `FU_STATE_META[fu]` badge (search the row component for `fuMeta`/`FU_STATE_META`).
  - The `FollowUpSection` function (~lines 705-770) and its `<FollowUpSection customer={customer} />` usage (~line 544).
  - Now-unused imports from `../../lib/customers`: `computeFuState`, `recordFollowUp`, `FU_STATE_META`, and the `FuState` type. Keep `useCustomers`, `Customer`, and anything still referenced.

- [ ] **Step 2: Add the link.** Add `import { Link } from 'react-router-dom';` (if not already imported). Where the `OverdueFollowupPanel` used to render (after the `kpiRow`), add:
```tsx
      <div className={styles.followupMoved}>
        Follow-ups now live in{' '}
        <Link to="/service?tab=followups">Service → Follow-Ups →</Link>
      </div>
```
Add to `app/src/modules/Customers/Customers.module.css`:
```css
.followupMoved { font-size: 13px; color: var(--color-ink-subtle); padding: 8px 0; }
.followupMoved a { color: #2b6cb0; font-weight: 600; text-decoration: none; }
.followupMoved a:hover { text-decoration: underline; }
```

- [ ] **Step 3: Update the mobile tab subtitle** (~line 211) — change the `directory` subtitle from `'All customers · search · follow-up state'` to `'All customers · search'`.

- [ ] **Step 4: Typecheck (surfaces any missed unused import/reference)** — `cd app && npx tsc --noEmit`. Fix anything flagged (e.g., a leftover reference to a removed symbol). Then `npm run lint`. Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Customers/index.tsx app/src/modules/Customers/Customers.module.css
git commit -m "refactor(customers): remove follow-up UI; link to Service → Follow-Ups"
```

---

### Task 5: Full verification + fix any Customers tests

**Files:**
- Modify (if needed): existing Customers test files referencing FU.

- [ ] **Step 1: Run the whole suite** — `cd app && npm test`. If any test fails because it asserted the Customers FU filter/column/section (search `app/src/modules/Customers/__tests__` for `fuFilter`, `Follow-up`, `FollowUpSection`, `overdue`), update or remove those assertions to match the new Customers UI. Re-run until green.

- [ ] **Step 2: Lint gate + build** — `cd app && npm run lint && npm run build`. Expected: lint exit 0, build success.

- [ ] **Step 3: Grep for stragglers** — `grep -rn "OverdueFollowupPanel" app/src/modules/Customers` (expect none) and `grep -rn "Customers/OverdueFollowupPanel" app/src` (expect none). Confirm no cross-module import remains.

- [ ] **Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "test(customers): update for removed follow-up UI"
```

---

## Self-review notes
- **Spec coverage:** §3.1 relocate → Task 2; §3.2 mount → Task 3; §3.3 deep-link → Task 1; §3.4 strip + link → Task 4; §6 testing → Tasks 1–5. All covered.
- **Deploy gate:** every task runs `npm run lint` (the eslint gate that previously blocked the Pages deploy).
- **Cross-module rule:** Task 2 moves the component into Service so `FollowUpsTab` imports it locally (no Customers→Service or Service→Customers import).
- **overdueCustomerIds:** derived in `FollowUpsTab` from `useFollowUpDirectory` rows (overdue ∪ due_today, oldest-onboard first) — consistent prop shape with the panel's `Props { overdueCount, overdueCustomerIds }`.
