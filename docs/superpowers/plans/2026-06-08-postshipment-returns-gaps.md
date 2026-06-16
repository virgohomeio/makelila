# PostShipment Returns/Refunds Gap-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining spec gaps in backlog #2 (Returns & Refunds): add a "Responsible Team" breakdown to the PostShipment dashboard, and fix the finance-approve modal to base "non-refundable shipping" on what the customer actually paid.

**Architecture:** Domain logic (category→team mapping + aggregation) lives in `lib/postShipment.ts` as a pure, unit-tested helper, matching the codebase convention that `lib/` holds tested logic and `modules/` stay presentational. `DashboardTab` consumes the helper to render one more chart. The finance modal's shipping bug is a mechanical column swap (`freight_estimate_usd` → `customer_paid_shipping_usd`) inside an existing Supabase query, verified by typecheck/build.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest, CSS Modules, Supabase.

---

## File Structure

- `app/src/lib/postShipment.ts` — **Modify.** Add `CATEGORY_TEAM` mapping, `RETURN_TEAMS` order, and pure `returnTeamCounts()` helper. Natural home alongside the existing `RETURN_CATEGORY_META`.
- `app/src/lib/postShipment.test.ts` — **Create.** Unit tests for `returnTeamCounts()`.
- `app/src/modules/PostShipment/DashboardTab.tsx` — **Modify.** Compute `byTeam` via the helper; render a "Responsible Team" donut chart in the existing `dashGrid`.
- `app/src/modules/PostShipment/RefundsTab.tsx` — **Modify.** `FinanceApproveModal` reads `customer_paid_shipping_usd` instead of `freight_estimate_usd`; relabel the hint.

**Out of scope:** #79 (netting recoverable value of returned units) — separate backlog item, separate plan.

---

### Task 1: Category→team mapping + aggregation helper (lib, TDD)

**Files:**
- Modify: `app/src/lib/postShipment.ts` (insert after `RETURN_CATEGORIES`, ~line 49)
- Test: `app/src/lib/postShipment.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/postShipment.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { returnTeamCounts } from './postShipment';

describe('returnTeamCounts', () => {
  it('maps categories to teams, orders by RETURN_TEAMS, drops empty teams', () => {
    const rows = [
      { return_category: 'product_defect' as const },
      { return_category: 'product_defect' as const },
      { return_category: 'software_issue' as const },
      { return_category: 'financing' as const },
    ];
    expect(returnTeamCounts(rows)).toEqual([
      { label: 'Engineering', value: 2 },
      { label: 'Software', value: 1 },
      { label: 'Finance', value: 1 },
    ]);
  });

  it('counts null and "other" categories as Unassigned', () => {
    const rows = [
      { return_category: null },
      { return_category: 'other' as const },
    ];
    expect(returnTeamCounts(rows)).toEqual([
      { label: 'Unassigned', value: 2 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(returnTeamCounts([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app; npx vitest run src/lib/postShipment.test.ts`
Expected: FAIL — `returnTeamCounts` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

In `app/src/lib/postShipment.ts`, insert immediately after the `RETURN_CATEGORIES` array (the block ending at ~line 49):

```ts
// Responsible-team accountability mapping (PostShipment dashboard, George's
// ask). Derived from return_category — no separate column. A return with no
// category counts toward 'Unassigned' alongside the 'other' category.
export const CATEGORY_TEAM: Record<ReturnCategory, string> = {
  product_defect:   'Engineering',
  software_issue:   'Software',
  shipping_damage:  'Logistics',
  customer_service: 'Customer Service',
  financing:        'Finance',
  other:            'Unassigned',
};

export const RETURN_TEAMS: string[] = [
  'Engineering', 'Software', 'Logistics', 'Customer Service', 'Finance', 'Unassigned',
];

/** Counts returns per responsible team, ordered by RETURN_TEAMS, dropping
 *  teams with zero returns. Null/unknown category → 'Unassigned'. */
export function returnTeamCounts(
  rows: Array<Pick<ReturnRow, 'return_category'>>,
): Array<{ label: string; value: number }> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const team = r.return_category ? CATEGORY_TEAM[r.return_category] : 'Unassigned';
    counts[team] = (counts[team] ?? 0) + 1;
  }
  return RETURN_TEAMS
    .filter(t => (counts[t] ?? 0) > 0)
    .map(t => ({ label: t, value: counts[t] }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app; npx vitest run src/lib/postShipment.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/postShipment.ts app/src/lib/postShipment.test.ts
git commit -m "feat(postShipment): add returnTeamCounts helper for responsible-team dashboard"
```

---

### Task 2: Render "Responsible Team" chart in DashboardTab

**Files:**
- Modify: `app/src/modules/PostShipment/DashboardTab.tsx`

- [ ] **Step 1: Import the helper**

Change the `lib/postShipment` import block (top of file) to add `returnTeamCounts`:

```ts
import {
  useReturns, useRefundApprovals,
  RETURN_CATEGORIES, RETURN_CATEGORY_META, returnTeamCounts,
  type ReturnRow, type RefundApproval,
} from '../../lib/postShipment';
```

- [ ] **Step 2: Add a UI color palette constant**

Immediately after the `MONTH_LABELS` line, add:

```ts
const TEAM_COLORS = ['#9b2c2c', '#2b6cb0', '#c05621', '#553c9a', '#276749', '#718096'];
```

- [ ] **Step 3: Extend the Aggregates type**

In the `type Aggregates = { ... }` block, add a `byTeam` field after `byCategory`:

```ts
  byTeam: Array<{ label: string; value: number }>;
```

- [ ] **Step 4: Compute byTeam in computeStats**

In `computeStats`, after the `byMonth` computation (just before the `return { ... }`), add:

```ts
  // Chart 5: responsible team (derived from category)
  const byTeam = returnTeamCounts(returnsYTD);
```

Then add `byTeam` to the returned object:

```ts
  return { totalYTD, refundedYTD, avgDaysToRefund, denialRate, byCategory, byChannel, byCondition, byMonth, byTeam };
```

- [ ] **Step 5: Render the chart card**

In the `DashboardTab` component's `dashGrid`, add a fifth `ChartCard` after the Monthly Trend card:

```tsx
        <ChartCard title="Responsible Team"><DonutChart data={stats.byTeam} colors={TEAM_COLORS} /></ChartCard>
```

- [ ] **Step 6: Verify typecheck/build**

Run: `cd app; npx tsc --noEmit`
Expected: no errors in `DashboardTab.tsx`.

- [ ] **Step 7: Commit**

```bash
git add app/src/modules/PostShipment/DashboardTab.tsx
git commit -m "feat(postShipment): add Responsible Team chart to returns dashboard"
```

---

### Task 3: Fix finance modal to use customer-paid shipping

**Files:**
- Modify: `app/src/modules/PostShipment/RefundsTab.tsx` (`FinanceApproveModal`, ~lines 657-727)

- [ ] **Step 1: Swap the order query + state shape**

Replace the `shipping` state declaration and its `useEffect`:

```ts
  const [shipping, setShipping] = useState<{ total: number; paidShipping: number } | null>(null);
  useEffect(() => {
    const ref = linkedReturn?.original_order_ref;
    if (!ref) { setShipping(null); return; }
    (async () => {
      const { data } = await supabase
        .from('orders')
        .select('total_usd, customer_paid_shipping_usd')
        .eq('order_ref', ref)
        .maybeSingle();
      if (data) {
        const d = data as { total_usd: number; customer_paid_shipping_usd: number | null };
        setShipping({
          total: Number(d.total_usd),
          paidShipping: Number(d.customer_paid_shipping_usd ?? 0),
        });
      }
    })();
  }, [linkedReturn?.original_order_ref]);
```

- [ ] **Step 2: Relabel the hint**

Replace the `shipping && (...)` fragment in the Amount field's `modalHint`:

```tsx
            {shipping && (
              <> · Order total: ${shipping.total.toFixed(2)} · Shipping (customer-paid, non-refundable): ${shipping.paidShipping.toFixed(2)} · Max refundable: ${(shipping.total - shipping.paidShipping).toFixed(2)}</>
            )}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd app; npx tsc --noEmit`
Expected: no errors in `RefundsTab.tsx` (the old `freight` field is fully removed).

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/PostShipment/RefundsTab.tsx
git commit -m "fix(postShipment): base non-refundable shipping on customer_paid_shipping_usd (#65)"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd app; npx vitest run`
Expected: all tests pass, including the new `postShipment.test.ts`.

- [ ] **Step 2: Production build**

Run: `cd app; npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Manual sanity (optional, if dev server available)**

Run: `cd app; npm run dev`, open PostShipment → Dashboard tab, confirm a "Responsible Team" donut renders; open a finance-review refund linked to an order and confirm the hint reads "Shipping (customer-paid, non-refundable)".
