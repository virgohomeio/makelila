# Returns & Refunds Overhaul — Design

> Alpha-feedback P1 #2. Sources: George Yin + Pedrum Amin (alpha email thread), plus meeting-derived items: return root-cause categorization (5/20 + 5/26) and refund "back to original card" (5/20).

**Goal:** Close 6 specific gaps in the existing returns + refund-approval workflow. No rewrite — surgical additions to ReturnsTab, RefundsTab, and a new Dashboard tab.

**Context:** The 2-stage refund approval flow (George manager → Julie finance), `refund_approvals` table, RefundsTab Kanban, customer-form auto-promotion, and Cancellations auto-refund all already exist (commits b9e8d2e, e85a246, 2a078ee). 22 email templates are seeded across all categories.

## Gaps closed

| ID | Gap | Solution |
|----|-----|----------|
| A | `returns.reason` is free-text → no category analytics possible | Add `return_category` enum column (6 values), keep `reason` as detail text |
| B | No refund method captured on the approval | Add `refund_method` enum column (5 values) on `refund_approvals` |
| C | Julie can't correct refund amount during finance review (Katrina Dowd case) | Editable amount + required correction note when changed |
| D | No reporting view for returns | New "Dashboard" tab in PostShipment (first tab) |
| E | Refund can be approved before unit received | Guard at `financeApprove`: linked return must be in `received` / `inspected` / `closed` |
| F | Customer-paid shipping should be capped out of refund | Show non-blocking hint in finance form: "Original total: $X · Shipping (non-refundable): $Y · Max refundable: $Z" |

## Schema

**Migration:** `20260527120000_returns_refunds_overhaul.sql`

```sql
-- A. Return category
create type return_category as enum (
  'product_defect', 'software_issue', 'shipping_damage',
  'customer_service', 'financing', 'other'
);
alter table public.returns add column return_category return_category;

-- B. Refund method
create type refund_method as enum (
  'shopify', 'sezzle', 'quickbooks_cc', 'bank_etransfer', 'original_card'
);
alter table public.refund_approvals
  add column refund_method refund_method,
  add column original_amount_usd numeric(10,2),
  add column amount_correction_note text;

-- Capture the as-submitted amount once (frozen on submission)
update public.refund_approvals
   set original_amount_usd = refund_amount_usd
 where original_amount_usd is null;
```

No new tables. All nullable to avoid breaking existing rows.

## Lib changes (`app/src/lib/postShipment.ts`)

- Add `ReturnCategory` type + `RETURN_CATEGORY_META` (label, color)
- Add `RefundMethod` type + `REFUND_METHOD_META`
- Extend `ReturnRow` with `return_category: ReturnCategory | null`
- Extend `RefundApproval` with `refund_method`, `original_amount_usd`, `amount_correction_note`
- New mutation: `updateReturnCategory(id, category)`
- Modify `financeApprove(id, opts: { method: RefundMethod, amount?: number, correction_note?: string, note?: string })`:
  - **Guard E:** if `return_id` is set, fetch linked return; throw if status not in {received, inspected, closed}
  - If `amount` differs from `original_amount_usd`, `correction_note` is required
  - Persists `refund_method`, possibly-updated `refund_amount_usd`, and `amount_correction_note`

## UI changes

### ReturnsTab detail panel
- Category dropdown above existing free-text "reason" textarea
- Visible everywhere a return is shown (search results, customer-form intake, ops creation)

### RefundsTab finance review form
- New fields when status reaches `finance_review`:
  - **Method** dropdown (required to approve)
  - **Amount** input (pre-filled with original; if changed, correction note becomes required)
  - **Correction note** (textarea; hidden until amount changes)
  - **Shipping hint** (read-only line below amount): looks up the order from `original_order_ref`, shows `total - freight = max refundable`
- Replace the current `window.prompt` flow with a proper modal

### New DashboardTab
First tab in PostShipment. Layout:
- KPI strip: Total returns YTD · Refunded $ YTD · Avg days-to-refund · Denial rate
- Bar chart: Returns by category (6 bars, using new `return_category`)
- Donut: Returns by channel (US / Canada)
- Bar: Returns by condition (like-new / good / fair / used / damaged / unused)
- Line: Monthly returns YTD (12 months)

Charts are inline SVG components — no new npm dep. Reuses existing CSS module variables.

## Out of scope (deferred)

- "Responsible Team" breakdown (alpha spec mentions; ambiguous what "responsible team" means — need follow-up from George)
- SMS notifications on refund state changes (P1 #3 SMS layer is deferred)
- Refund webhook callbacks (manual Resend confirmation only)
- Multi-currency display (USD-only)
- Hard cap on refund amount based on shipping (we surface the cap; we don't enforce it — Julie may have valid reasons to exceed)
