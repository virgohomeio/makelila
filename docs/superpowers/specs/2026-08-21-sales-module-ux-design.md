# Sales module — UX rework

**Date:** 2026-08-21
**Status:** Shipped
**Scope:** `/order-review` (the "Sales" module) — presentation and structure only. No schema, no new capability.

---

## 1. Why

Sales works but costs time per order. Twelve defects, all confirmed by reading the code rather than assumed:

| # | Defect |
|---|---|
| 1 | Rail was `--color-dark-1` with a private palette (`#232323`, `#2a1010`, `#252525`, `#888`) used nowhere else; detail pane was white. Two apps stitched together. |
| 2 | View chips (Orders/Templates/Upload) and status tabs were the same crimson pill, stacked, though they are different navigational levels. |
| 3 | Seven status tabs at 10px uppercase in a 320px rail, scrolling sideways. A CSS comment records Cancelled having been clipped out of reach. |
| 4 | `OrderRow` was one wrapping meta line — country, verdict, area, ref, badge, city, urgency, freight quote. Nothing aligned, so two rows could not be compared. |
| 5 | Order refs and money in proportional Inter — digits did not align down the column. |
| 6 | Confirm disabled with the fix out of sight, and the tooltip claimed **3** readiness criteria when `evaluateReadiness` returns **2**. Stale since the freight check was dropped (2026-06-05). |
| 7 | Cancel — terminal, no undo anywhere in the app — was a filled red slab in position 2, beside Confirm. |
| 8 | Opening a reason input **replaced** the action bar, taking order identity and the primary action off screen. |
| 9 | The confirm SLA appeared three times in three vocabularies: row chip, body banner, "Due:" pill. |
| 10 | Eight identical cards in one flat column. The two criteria gating Confirm were stated in card 1 and repaired in cards 2 and 3. |
| 11 | `⚠ Missing — complete via QUO` was inert text; the QUO link sat at the bottom of the card. |
| 12 | Off-palette leaks: sync button on `--color-us-navy` (a legacy US-flag slot), cost bars hardcoding the cool ramp (`#e2e8f0`, `#48bb78`, `#e53e3e`). |

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Brand | **tokens.css as shipped** | Operator instruction. Ladybug Red, Inter, warm neutrals unchanged. |
| Rail | **Light (`--color-surface`)** | Operator did not call it; light is the option consistent with the other eleven modules, which is the redesign spec's whole point. One class (`.sidebar` background) reverses it. |
| Primary action colour | **Green, not Ladybug Red** | Deviates from redesign spec §5.1 ("Ladybug Red for primary buttons"). Confirming is the affirmative disposition and a red confirm button reads as destructive. Crimson is spent on the active status pill and the selected row instead. |
| Error red | **No token change needed** | Phase 0 (`b1bbdb7`) already moved `--color-error` to `#7F1D1D`. The Cancel/Confirm collision is additionally solved structurally — Cancel is no longer a filled button. |
| Scope | **Presentation + structure only** | No keyboard nav, no prev/next, no bulk actions. Same 7 tabs, same replacement sub-tabs, same 5 dispositions, same fields, same hooks. |

### Signature element — the blocker strip

The module's whole job is *can this order be confirmed, and if not what fixes it*. That question now gets one strip directly under the button it gates, with the repair link on the same line as the fault (`Fix in Customer →` scrolls to and flashes the card). Everything around it stays quiet. This replaces the readiness card that sat below the fold.

## 3. What changed

- **Rail** — light, on-token. Status tabs are pills that wrap to two rows with weighted count badges. Search gained an icon and a clear button; a result count sits above the list.
- **Row** — a 2×2 grid. Identity left, state in a right-aligned column so tags and SLA form true columns. Refs use `--font-mono` + `--font-numeric`. A blocker dot replaces nothing — it is new signal derived from existing data. Rows are real `<button>`s with an explicit `aria-label`; they announced as `Alice Ames125d OVERDUE#p1· PortlandUS` before.
- **Detail header** — order ref, name, location and the SLA are pinned above the actions.
- **Action bar** — one primary (`✓ Confirm order`), three quiet secondaries, and `Cancel order` demoted to a text action behind a divider. The bar never disappears; reason capture opens a drawer beneath it. The drawer's submit verb repeats the action's name (`Flag order`, not `Submit`), and its dismiss is **Discard** — "Cancel" already means "kill the order" in this bar.
- **Body** — cards grouped `Review / Fulfilment / Money / Log`, two across.
- **SLA** — stated twice, not three times, and both surfaces render the identical `orderUrgency()` label.
- **`CRITERIA_COUNT`** — exported from `ReadinessChecklist` and consumed by `ActionBar`, so the count in the copy cannot drift from the logic again.

## 4. Housekeeping folded in

- `OrderReview.module.css` is enrolled in `check-css-tokens.mjs` `MIGRATED`. It contains **zero raw hex**; the build fails if any returns. This is the redesign spec's Phase 4 discipline applied to Sales.
- New token `--color-raised: #FFFFFF`, completing the ground ramp `surface → page → raised`. Other modules should reach for it as they migrate off `#fff`.
- `syncShopifyOrders()` moved into `lib/orders.ts`. `Sidebar` was importing `supabase` directly, against AGENTS.md.

## 5. Known deviations

1. **Out of the redesign spec's Phase 4 order** (Team · Finance · Products · Hiring · Stock · **Sales** · …), and ahead of the Phase 3 Fulfillment pilot. The operator asked for Sales specifically. The constraint that actually matters — never more than one module of visual change in flight — still holds: no other module migration is open.
2. **Primary stays green**, per §2 above.
3. **No `components/ui/` primitives were built.** This module was migrated against tokens directly. When Phase 1 lands, Sales is a consumer to revisit — the shapes here (pill tab, status chip, card group) are candidates for `StatusPill`, `Tabs`, `Card`.

---

## 6. Support Tickets theme alignment — shipped, then reverted

`c7070c2` ported the Support Tickets page chrome onto Sales: an SLA rail in `sla.ts`
mirroring `Service/dwell.ts`, a full-width queue bar replacing the status pills, saved
views (Blocked · Overdue · Replacement queue), a single toolbar, and `ORDER_STATUS_META`
reusing `STATUS_META`'s warm palette under the same AA / non-competing-red contracts.

**Reverted the same day at the operator's request** (the revert of `c7070c2` on `main`).
Sales stands as §1–§5 describe.
The work is recoverable in full from `c7070c2` if it is ever wanted — recorded here so it
is not rebuilt from scratch by someone who does not know it was already tried.

One finding from that pass is worth keeping regardless, and is **not** fixed by the
revert: Support Tickets' `SavedViewChip` and queue legend put a count badge directly
against its label with no separating text node, so those controls announce to a screen
reader as `Unowned3` / `Action Needed12`. Sales' own controls carry explicit
`aria-label`s (added in `3b31a4c`, still in place); Service's do not.
