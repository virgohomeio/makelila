# Consolidate follow-up functionality into Service → Follow-Ups — Design Spec

**Date:** 2026-06-18
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

Make **Service → Follow-Ups** the single home for follow-up work. Move the
follow-up *sending* workflow there and remove the duplicate follow-up UI from
the Customers module, leaving a link.

## 2. Decisions (locked in)

| Decision | Choice |
|----------|--------|
| Redirect type | **Move the functionality in** (relocate to Follow-Ups; remove from Customers; leave a link). |
| Scope | Overdue draft+send panel **and** the Customers FU filters/column **and** the per-customer FollowUpSection (full consolidation). |
| Out of scope | Dashboard status SMS + ticket diagnosis-link SMS (not the FU1/FU2 cadence) — left as-is. |

## 3. Components

### 3.1 Relocate `OverdueFollowupPanel`
- Move `app/src/modules/Customers/OverdueFollowupPanel.tsx` and its test
  `__tests__/OverdueFollowupPanel.test.tsx` → `app/src/modules/Service/`.
  (AGENTS.md forbids cross-module imports, so it must live in Service to be
  consumed by `FollowUpsTab`.) No behavior change to the component itself.

### 3.2 Mount it in `FollowUpsTab`
- Render `<OverdueFollowupPanel>` full-width at the **top** of the Follow-Ups
  tab, above the calendar + directory split (it's a primary bulk action).
- Source its props from the existing `useFollowUpDirectory(today)` hook:
  `overdueCustomerIds` = the directory rows whose status set contains
  `'overdue'` **or** `'due_today'` (matches the prior Customers "needs action"
  set the panel was fed); `overdueCount` = that array's length.

### 3.3 Deep-linkable Service tabs
- `Service/index.tsx` currently holds the active tab in local `useState`.
  Change it to read the initial tab from a `?tab=` query param and update the
  URL on tab change, following the existing `useSearchParams` pattern in
  `Fulfillment/index.tsx`. Valid values are the existing `Tab` keys
  (`onboarding|followups|support|replacement|inbox`); unknown/missing →
  default `onboarding`. Applies to both desktop and mobile tab state.

### 3.4 Strip follow-up UI from Customers
Remove from `app/src/modules/Customers/index.tsx`:
- The `OverdueFollowupPanel` mount + `overdueIds` memo.
- The FU filter chips and their state/derivations: `fuFilter`, `fuCounts`,
  and the FU branch of the list filter/sort.
- The **"Follow-up"** table column header + its cell (the `FU_STATE_META`
  badge in the row).
- The per-customer **`FollowUpSection`** in the detail panel + its
  `recordFollowUp` usage.
- Now-unused imports (`computeFuState`, `recordFollowUp`, `FU_STATE_META`,
  `FuState`, `OverdueFollowupPanel`) and FU wording in the mobile tab subtitle
  (line ~211).

Add in its place a small link/banner:
> "Follow-ups moved to **Service → Follow-Ups**" → `/service?tab=followups`
(via React Router `Link`).

Customers retains: KPIs, country filter, search, the directory list, and the
customer detail panel (minus the FU section).

## 4. Data flow

```
useFollowUpDirectory() ──▶ FollowUpsTab
   rows (overdue/due_today) ──▶ OverdueFollowupPanel (generate drafts → send SMS)
   rows + counts            ──▶ FollowUpDirectory (filter/list)
Customers tab ── Link("/service?tab=followups") ──▶ Service opens Follow-Ups
```

## 5. Error handling
- Panel keeps its existing per-row error handling (generate/send failures).
- If `overdueCustomerIds` is empty, the panel shows its existing empty/zero
  state.
- Unknown `?tab=` value falls back to the default tab (no crash).

## 6. Testing
- Move `OverdueFollowupPanel.test.tsx` with the component; it must still pass.
- New test: `Service` renders the Follow-Ups tab when mounted at
  `?tab=followups` (wrap in `MemoryRouter` with the query string).
- Update/remove Customers tests that assert FU filters/column/section.
- Gate: `cd app && npm run lint` (exit 0 — this is the deploy gate),
  `npm test`, `npm run build` all green before push.

## 7. Risk / notes
- The directory already covers follow-up *viewing*; this adds *sending* and
  removes the Customers duplicates — net one home, less duplication.
- `OverdueFollowupPanel` imports only from `lib/` (cannedSms, customers), so it
  relocates cleanly with no cross-module dependency.
- Watch for other references to the moved file or removed Customers exports
  (grep before deleting).

## 8. Out of scope
- No change to how SMS is sent (`sendFollowupSms` / OpenPhone / test-redirect).
- Dashboard status SMS and ticket diagnosis-link SMS stay where they are.
