# Service Replacement Workflow — Design Spec

**Backlog ref:** #55 (`docs/feature-backlog-alpha-feedback.md`)
**Status:** Approved 2026-06-04
**Author:** Huayi + Claude (in-session brainstorm)

## Goal

Replace the Service module's stale "Repair" tab with a "Replacement" workflow: a CS operator opens a service ticket, clicks "Send replacement," builds a cart of parts and/or a whole replacement unit, and an internal replacement order flows through the same Order Review → Fulfillment → Post-Shipment pipeline that paid sales go through. When the carrier confirms (or an operator manually marks) delivery, the originating ticket auto-closes.

Replacement orders carry actual cost-of-goods and actual shipping cost on every row, which is the data foundation for backlog #58 (Customer Profitability tab).

## Decisions settled in brainstorm

| Decision | Choice |
|----------|--------|
| Storage shape | Extend `orders` with a `kind` discriminator (one table, one pipeline). |
| Workflow on "Send replacement" click | Immediately create the order with `status='pending'`. Order Review's existing approval is the gate. No separate draft step. |
| Customer email | Just the existing tracking email at ship time. No acknowledgment email at order creation. |
| Scope | Parts AND full units in one picker (cart-style). |
| Cart shape | One replacement order = one shipment = many line items. |
| Receipt → ticket close | Both carrier webhook AND manual "Mark delivered" button. Either triggers auto-close. |
| Cost tracking | Record `cogs_usd` + `shipping_cost_usd` on every order (sale and replacement). |

## Architecture

### Schema changes

**`orders` table — add 6 columns:**

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `kind` | text | `'sale'` | Enum-like: `'sale' | 'replacement'`. Check constraint enforces values. |
| `linked_ticket_id` | uuid | null | FK → `service_tickets.id` (`ON DELETE SET NULL`). Null for sales. |
| `cogs_usd` | numeric(10,2) | null | Sum of parts `cost_per_unit_usd × qty` + unit batch cost. Null for sales until backfilled. |
| `shipping_cost_usd` | numeric(10,2) | null | Actual freight/label cost. Distinct from `freight_estimate_usd` (Shopify customer-facing). Populated when Fulfillment commits the shipment. Applies to both sales and replacements. |
| `shipped_at` | timestamptz | null | Set by `markOrderShipped(orderId)`. The existing `orders.status` enum (`pending | approved | flagged | held`) is Order Review's state machine; downstream Fulfillment / Post-Shipment state is implied by these timestamps. |
| `delivered_at` | timestamptz | null | Set by `markOrderDelivered(orderId)`. Non-null = order delivered. Auto-close logic on the linked ticket fires here. |

**`service_tickets` table — add 1 column:**

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `replacement_order_id` | uuid | null | FK → `orders.id` (`ON DELETE SET NULL`). The ticket↔order backlink. Disables the "Send replacement" button when set. |

**`orders.line_items` (existing JSONB) — extended schema:**

Each line item is now one of:
```ts
// Sale line item (unchanged shape):
{ sku: string; name: string; qty: number; price_usd: number }

// Replacement part line item:
{ kind: 'part'; part_id: string; sku: string; name: string; qty: number;
  cost_per_unit_usd: number }

// Replacement unit line item (qty always 1):
{ kind: 'unit'; unit_serial: string; batch: string; name: string;
  qty: 1; cost_usd: number }
```

No migration of historical sale line items needed — the `kind` field is optional and undefined on legacy rows.

**Order ref numbering:**

Sales keep their Shopify-sourced `#1113` refs. Replacements use an internal sequence `R-0001`, `R-0002`, … zero-padded to 4 digits. New SQL function `next_replacement_order_ref()` returns the next ref by `MAX(order_ref::int) WHERE order_ref ~ '^R-'` + 1.

### Data flow

```
Service ticket (defect reported)
  └─→ operator clicks "Send replacement"
      └─→ ReplacementPickerModal opens
          ├─ shipping address (pre-filled from customer, editable)
          ├─ searchable dropdown adds line items to cart
          │   ├─ Parts section (parts.category='replacement', on_hand>0)
          │   └─ Replacement Unit section (units.status='ready')
          └─ Confirm
              └─→ createReplacementOrder({ticket_id, line_items, address})
                  ├─ INSERT orders (kind='replacement', status='pending',
                  │     linked_ticket_id, cogs_usd computed, order_ref=R-XXXX)
                  ├─ UPDATE service_tickets SET replacement_order_id=...
                  ├─ Decrement parts.on_hand for each part line item
                  ├─ Flip units.status 'ready'→'reserved' for unit line items,
                  │     set units.customer_order_ref=R-XXXX
                  └─ logAction('replacement_create', ...)

Order Review (operator approves) → status='approved'
  └─→ Fulfillment (existing flow)
      └─→ commit shipment → markOrderShipped(orderId, shipping_cost_usd)
          ├─ UPDATE orders SET shipped_at=now(), shipping_cost_usd=...
          ├─ send-fulfillment-email tracking email to customer
          └─→ delivery detected
              ├─ Path A (future): Post-Shipment carrier webhook → markOrderDelivered
              │   (walkthrough item #30; not wired today — same mutation, different
              │    caller once we have the webhook)
              └─ Path B (V1): Operator clicks "Mark delivered" in Post-Shipment
                  └─→ markOrderDelivered(orderId)
                      ├─ UPDATE orders SET delivered_at=now()
                      └─ if kind='replacement' AND linked_ticket_id:
                          ├─ UPDATE service_tickets SET status='closed',
                          │     resolved_at=now()
                          └─ logAction('ticket_auto_closed', ticket_id,
                                       'via replacement R-XXXX')
```

### Inventory bookkeeping

**Parts:** decrement `parts.on_hand` at replacement order *creation* (not at shipment), so the picker doesn't show parts that are already spoken for. If the order is cancelled before shipment, re-increment. Today `parts` has no separate "reserved" column — `on_hand` doubles as a soft reservation. If contention becomes a problem later, add a dedicated `parts.reserved` column and split the bookkeeping; for V1, the soft model is sufficient because replacement volume is low.

**Units:** flip `units.status` from `ready` to `reserved` at order creation, set `customer_order_ref` to the new `R-XXXX`. This mirrors the regular Order Review serial-assignment flow exactly. Fulfillment will flip it `reserved` → `shipped` as normal.

### Authorization

Any internal user (`profiles.is_internal=true`) can create a replacement. RLS on `orders` already enforces internal-only writes. No new role-based gating in V1.

## UI changes

### Service module

**Tab rename** (`Service/index.tsx`):
- Label `'Repair'` → `'Replacement'` in the TABS array.
- Code identifier `'repair'` stays for the route key to avoid a sweep across the codebase. Only the user-facing string changes.

**Tab component rename** (`Service/RepairTab.tsx` → `Service/ReplacementTab.tsx`):
- File renamed because the data source pivots — the tab now lists replacement *orders*, not repair-category tickets.

**Ticket detail panel** (`Service/TicketDetailPanel.tsx`):
- Add a "Send replacement" button. Visible only when `ticket.replacement_order_id IS NULL`.
- When `replacement_order_id` is set, the button is replaced with a "Replacement order: R-0042 (in Fulfillment)" link that opens the order in Order Review.

### Replacement picker modal (new)

**`Service/ReplacementPickerModal.tsx`:**

```
┌─────────────────────────────────────────────────────────┐
│ Send replacement — Linda Smith (ticket T-138)         × │
├─────────────────────────────────────────────────────────┤
│ Ship to:                                                │
│   [123 Maple Lane                  ]                    │
│   [Toronto       ] [ON ] [M5J 2N8] [CA]                 │
│   (pre-filled from customer record; editable)           │
├─────────────────────────────────────────────────────────┤
│ Add item: [ ▾ Search parts or units…       ]            │
│   Parts                                                 │
│     Lid Hinge (15 on hand) — $4.20                      │
│     Chamber Motor (8 on hand) — $42.00                  │
│   Replacement Unit                                      │
│     LL01-284 (Batch 7, White, ready) — $312.00          │
│     LL01-287 (Batch 7, Black, ready) — $312.00          │
├─────────────────────────────────────────────────────────┤
│ Cart                                                    │
│   2× Lid Hinge          $8.40    [−][+]  [✕]            │
│   1× LL01-284          $312.00            [✕]           │
├─────────────────────────────────────────────────────────┤
│ COGS total: $320.40                                     │
│                          [Cancel]  [Create order ▶]     │
└─────────────────────────────────────────────────────────┘
```

- Searchable dropdown source: combined list of `parts` (where `category='replacement'` AND `on_hand > 0`) + `units` (where `status='ready'`).
- Selecting a part adds it to cart with qty=1; qty editable inline (capped at `on_hand`).
- Selecting a unit adds it with qty fixed at 1; selecting it again is a no-op (a unit is unique).
- COGS total recomputes on every change.
- "Create order" → `createReplacementOrder({...})` → on success closes modal + navigates to the new order in Order Review.

### Replacement tab content

**`Service/ReplacementTab.tsx`:**

- Data source: `orders` where `kind='replacement'`, ordered by `created_at DESC`.
- KPI strip: Open replacements, Shipped (30d), Delivered (30d), Avg COGS (30d).
- Filter chips: All | Pending | Approved | Fulfilling | Shipped | Delivered | Closed.
- Columns: `order_ref` (e.g. `R-0042`), originating ticket # (clickable, opens the ticket panel), customer, item summary ("2 parts + 1 unit"), `cogs_usd`, current pipeline stage, days open.
- Row click opens the existing Order Review detail panel for that order.

## Pipeline integration

The point of using `kind` as a discriminator is that the downstream modules need minimal changes.

### Order Review (`OrderReview/`)
- "Replacement" badge on order cards + detail header when `kind='replacement'`.
- Payment card / financial breakdown hidden for replacements (no `total_usd` to display, no Shopify discount codes, no gateway).
- Address card stays — we still want to catch apt/remote postcodes for replacements.
- New section "Originating ticket" with a link back to the service ticket.
- Default `address_verdict` calculation runs the same way.

### Fulfillment (`Fulfillment/`)
- "Replacement" badge on queue rows + shelf cards.
- No flow changes. Parts already decremented from `on_hand` at order creation; whole-unit replacements use the existing serial picker (already wired to `units.status='ready'`).
- Tracking email template (`send-fulfillment-email`) unchanged — "Your order #X has shipped" works for both sales and replacements.
- When the operator commits the shipment (the existing "Ship" / "Label" action in `Fulfillment/Queue/`), prompt for `shipping_cost_usd` (the actual label cost from the Freightcom/ClickShip receipt) before calling `markOrderShipped()`. Same prompt appears for both sales and replacements going forward — this is what powers backlog #58 profitability analytics.

### Post-Shipment (`PostShipment/`)
- "Replacement" badge on Returns / Refunds / History tabs.
- Refund logic intact (a replacement can itself be returned if it didn't fix the problem); the refund-method dropdown reads `n/a` for replacements since there's nothing to refund financially.
- **New "Mark delivered" button** sits next to the existing tracking field on the order detail. Calls `markOrderDelivered(orderId)`. For sale orders it just flips status; for replacement orders it also auto-closes the linked ticket.

## Activity log

New event types:
- `replacement_create` — `R-0042 from ticket T-123, 2 parts + 1 unit, COGS $X`
- `replacement_delivered` — `R-0042 delivered` (fires alongside the existing `order_delivered` for replacement orders)
- `ticket_auto_closed` — `T-123 auto-closed via replacement R-0042`

Existing event types (`order_create`, `order_approve`, `order_shipped`, etc.) work unchanged.

## Out of scope (deferred follow-ups)

- **Restocking returned replacement parts.** Today, a returned part shipment doesn't auto-restock `parts.on_hand`. We'll log the return like any other; restock is manual until we have a clear use case.
- **Bulk-cancel of unused replacement orders.** Cancel one at a time.
- **Customer acknowledgment email at order creation.** Per Section 0 — we only send the tracking email at ship time.
- **Profitability rollups.** Deferred to backlog #58, which depends on the `cogs_usd` + `shipping_cost_usd` columns this spec adds.
- **Auto-shipping-cost from Freightcom/ClickShip.** Operator enters `shipping_cost_usd` manually at ship time in V1; auto-fill via a freight integration is a separate effort (ties to walkthrough #7 + #19).

## Testing

### Unit (Vitest)
- `lib/orders.test.ts`
  - `nextReplacementOrderRef()` increments `R-0001` → `R-0002`, zero-pads
  - `createReplacementOrder()` inserts with `kind='replacement'`, computes `cogs_usd` correctly across parts + units, sets `linked_ticket_id`
  - `createReplacementOrder()` decrements `parts.on_hand` and flips `units.status` atomically (one transaction or rollback on failure)
  - `markOrderDelivered()` flips status; for `kind='replacement'` also closes the linked ticket and logs `ticket_auto_closed`; for `kind='sale'` leaves ticket fields untouched
- `Service/ReplacementPickerModal.test.tsx`
  - Cart add / remove / qty edit
  - COGS recompute on qty change
  - Picker filters out `parts.on_hand=0` and non-`ready` units
  - Address card pre-fills from customer record, edits propagate to confirm payload
  - Cannot add the same unit twice
- `Service/ReplacementTab.test.tsx`
  - Lists `kind='replacement'` orders only
  - KPI strip math (open count, 30-day shipped, 30-day delivered, avg COGS)
  - Row click opens Order Review detail

### Integration (Playwright)
- End-to-end: open a ticket → "Send replacement" → add 2 parts + 1 unit to cart → confirm → assert order appears in Order Review with "Replacement" badge → approve → assert in Fulfillment → mark shipped + enter shipping cost → mark delivered → assert ticket status flipped to `closed` + activity log entries

## Migration / rollout

- One SQL migration:
  - `orders`: add `kind`, `linked_ticket_id`, `cogs_usd`, `shipping_cost_usd`, `shipped_at`, `delivered_at`
  - `service_tickets`: add `replacement_order_id`
  - Function `next_replacement_order_ref()` returning text
  - Check constraint `kind IN ('sale', 'replacement')`
  - All existing rows pick up `kind='sale'` from the column default. Historical `shipped_at` / `delivered_at` stay null on legacy sale rows (no backfill from external sources in this migration; can come later).
- No edge-function changes — `send-fulfillment-email`, `verify-address`, `sync-shopify-orders`, etc. all work over `orders` rows agnostic of `kind`. (The Shopify sync continues to insert with default `kind='sale'`.)
- Frontend code split into the smallest commits possible (schema first; createReplacementOrder mutation; picker modal; tab rename + new content; pipeline badges) so each can be reviewed and rolled forward independently.
