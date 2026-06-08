# Replacement Tagging + Pending Replacements — Design Spec

**Date:** 2026-06-08
**Author:** Huayi Gao (with Claude)
**Status:** Draft for review

---

## 1. Problem

Replacements are not truly ticket-driven yet. The "Send replacement" picker only
offers **in-stock parts** and **`ready` units**, so the most common real cases —
a part we're out of, or a unit whose batch is still in production (P100X) — can't
be entered at all. Today those rows only exist because they were **bulk-imported
via migration** (`20260605080000`) and hand-flagged with `awaiting_batch_id` via
a one-off SQL migration (`20260604320000`). `awaiting_batch_id` is **read-only in
the app** — nothing in the UI writes it. (Confirmed: Cheryl Lemieux's R-0032 is
`status='pending'`, `awaiting_batch_id='P100X'`, `line_items=[]` — un-creatable
through the picker.)

Separately, the **Service → Replacement** tab shows replacement orders with a
free-text "Items" column and a coarse stage; operators want structured, accurate
**item tags** and **stage tags** per customer.

## 2. Goal

Make replacements fully ticket-driven: the "Send replacement" picker can capture
**in-stock, out-of-stock, and pending-batch** items; out-of-stock / pending
selections create a **pending replacement** that lands in an **Awaiting Stock /
Batch** queue; in-stock selections create a **ready** replacement. Surface
structured item + stage tags on **Service → Replacement** and backfill the
existing rows.

## 3. Decisions (locked in during brainstorming)

| Decision | Choice |
|----------|--------|
| Data model | **Order-centric.** Replacements stay `orders` rows (`kind='replacement'`). |
| Ready vs Awaiting | **Persisted** `orders.replacement_state` (`'ready' \| 'awaiting'`), set at creation — not live-derived (stock changes after creation; persistence matches the two-button UX). |
| Item storage | **Structured `line_items`** (extended), not a separate tag column — reuses what's there, keeps the picker as the single writer. |
| 2-tab queue location | **Order Review → Replacement** splits into **Replacement Orders (Ready)** and **Awaiting Stock / Batch**. |
| Stage tag labels | P100 & P150 → **"Unit"** · P100X (and other pending batches) → **"awaiting batch"** · any part/consumable → **"Parts/Consumables"**. |
| Part B scope | **Only the ~23 customers already in the Service → Replacement tab.** No new customers from the sheet. |

## 4. Architecture

### 4.1 `ReplacementLineItem` — extend with pending variants

```ts
export type ReplacementLineItem =
  | { kind: 'part';         part_id; sku; name; qty; cost_per_unit_usd }   // in stock → decrement
  | { kind: 'part_pending'; part_id; sku; name; qty; cost_per_unit_usd }   // out of stock → NO decrement
  | { kind: 'unit';         unit_serial; batch; name; qty: 1; cost_usd }   // ready → reserve
  | { kind: 'unit_pending'; batch; name; qty: 1; cost_usd };               // pending batch → NO reserve, sets awaiting_batch_id
```
(`unit_pending` already exists in the Excel-import shape, so `summarize()` and the
type guards must tolerate all four.)

### 4.2 `Send replacement` picker — 4 sections (`ReplacementPickerModal`)

| Section | Source | Adds line of kind |
|---|---|---|
| **Parts (In Stock)** | `parts` where `category='replacement'` AND `on_hand>0` | `part` |
| **Replacement Units Available** | `units` where `status='ready'` (today) | `unit` |
| **Parts (Out of Stock)** | `parts` where `category='replacement'` AND `on_hand=0` | `part_pending` |
| **Pending Batch** | `batches` with **no `ready` units** (P100X + future) | `unit_pending` |

**Two gated buttons** (mutually exclusive on cart contents):
- Cart contains **any** `part_pending`/`unit_pending` → only **"Create pending replacement"** enabled → `createPendingReplacement()`.
- Cart is **all** `part`/`unit` (everything available) → only **"Create replacement order"** enabled → `createReplacementOrder()` (today's path).
- Empty cart → both disabled.

### 4.3 Order creation

- **`createReplacementOrder` (ready)** — unchanged behaviour: `replacement_state='ready'`, decrements parts (`decrement_part_on_hand`), reserves units.
- **`createPendingReplacement` (new)** — `replacement_state='awaiting'`, `status='pending'`; **does NOT** decrement parts or reserve units; sets `awaiting_batch_id` to the first `unit_pending` batch (if any); back-links + sets the ticket to `queued_for_replacement` (consistent with the prior change).

### 4.4 DB migration

```sql
alter table public.orders
  add column if not exists replacement_state text
    check (replacement_state in ('ready','awaiting'));
-- Backfill existing replacement orders:
update public.orders
   set replacement_state = case
     when awaiting_batch_id is not null then 'awaiting'
     when line_items = '[]'::jsonb       then 'awaiting'
     when exists (… any line_item kind ends with '_pending' …) then 'awaiting'
     else 'ready' end
 where kind = 'replacement';
```

### 4.5 Order Review → Replacement — 2 sub-tabs

When the Sidebar `'replacement'` tab is active, show a sub-toggle:
- **Replacement Orders (Ready)** → `replacement.filter(o => o.replacement_state !== 'awaiting')`
- **Awaiting Stock / Batch** → `replacement.filter(o => o.replacement_state === 'awaiting')`

### 4.6 Service → Replacement — item + stage tags

- **Item tags** derived from `line_items`, mapped to the fixed vocabulary:
  `P100 · P100X · P150 · starter kit · manual · chamber-L · chamber-R · filter ·
  hopper · lid · side latch-L · side latch-R`. Multiple tags per order. Rendered
  as chips in the Items column (replacing the free-text `summarize()` string).
- **Stage tag** derived per order (precedence so multi-item orders resolve):
  1. any **P100X / pending-batch** item → **"awaiting batch"**
  2. else any **P100 / P150** unit → **"Unit"**
  3. else (parts/consumables only) → **"Parts/Consumables"**

### 4.7 Part B data backfill (existing rows only)

Normalize the ~23 existing replacement orders' `line_items` free-text descriptions
to the structured vocabulary. Mapping:

| Current description | Tag(s) |
|---|---|
| `P100` | P100 |
| `P100 X` / `P100X` | P100X |
| `P150` | P150 |
| `starter bags` | starter kit |
| `Replacement top lid` | lid |
| `Hopper` | hopper |
| `filter cup` | filter |
| `left side chamber` | chamber-L |
| `broken compost chamber (right side)` | chamber-R |
| `both compost chambers cracked` | chamber-L + chamber-R |
| `right side latch` | side latch-R |
| `both side latch` | side latch-L + side latch-R |

**Ambiguous — flag for operator, do NOT guess:**
`side latch (? side)`, `side latch (?) and filter cup` (latch side unknown),
`Side latch + compost chambers` (which latch? both chambers?), and free-text
damage notes that imply a full unit but no model (e.g. "Unit cracked on arrival …
Needs full replacement unit"). These get listed in the plan for a manual call.

## 5. Out of scope

- New customers from the sheet (only existing tab rows).
- Editing tags directly as chips (tags are derived from `line_items`; editing
  happens through the picker / a later enhancement).
- Auto-promoting an awaiting order to ready when stock/batch arrives (#71's
  promote sweep is separate).

## 6. Testing

- `orders.test.ts`: `createPendingReplacement` sets `replacement_state='awaiting'`,
  does NOT call `decrement_part_on_hand` / reserve units, sets `awaiting_batch_id`,
  and flips the ticket to `queued_for_replacement`. `createReplacementOrder` still
  decrements/reserves and is `'ready'`.
- `ReplacementPickerModal.test.tsx`: 4 sections render from mocked parts/units/
  batches; button gating (pending vs ready) toggles on cart contents.
- Order Review: sub-tab split filters on `replacement_state`.
- Service → Replacement: tag derivation + stage-tag precedence unit tests.

## 7. File touch list

| File | Action |
|------|--------|
| `app/src/lib/orders.ts` | extend `ReplacementLineItem`; add `createPendingReplacement`; `Order.replacement_state`; type guards |
| `supabase/migrations/<ts>_orders_replacement_state.sql` | add column + backfill |
| `supabase/migrations/<ts>_backfill_replacement_item_tags.sql` | normalize existing `line_items` (non-ambiguous) |
| `app/src/modules/Service/ReplacementPickerModal.tsx` | 4 sections + 2 gated buttons |
| `app/src/modules/Service/ReplacementTab.tsx` | item-tag chips + stage-tag derivation |
| `app/src/modules/OrderReview/Sidebar.tsx` (+ index) | Ready / Awaiting Stock-Batch sub-tabs |
| `app/src/lib/stock.ts` | helper: batches with no `ready` units (pending batches) |
| tests as in §6 |

## 8. Risks

- **Multi-item stage precedence** — an order with both a unit and parts resolves
  by the §4.6 precedence; confirm that matches operator expectation.
- **`line_items` shape drift** — four kinds now; every reader (`summarize`,
  profitability COGS, type guards) must handle all four.
- **Ambiguous backfill rows** — flagged, not guessed; operator resolves.

## 9. Open questions

- Item-tag chip labels for units: show `P100` (plain) since the stage tag conveys
  availability — confirm vs `awaiting P100`.
- Should "Awaiting Stock / Batch" in Order Review further split parts-vs-batch, or
  is one combined awaiting tab enough? (Spec assumes combined.)
