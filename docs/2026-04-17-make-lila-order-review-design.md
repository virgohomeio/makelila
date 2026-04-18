# Make Lila — Order Review Module Design

> Follow-on to [`2026-04-16-make-lila-shared-infra-plan.md`](./2026-04-16-make-lila-shared-infra-plan.md), now shipped as `v0.1.0-infra`. This design scopes the **Order Review** module. Implementation plan will be written separately (see Next Steps).

## Goal

Replace the placeholder Order Review module with a working triage UI: reviewers select pending orders from a sidebar, scan customer/address/freight signals, and disposition each order as **approved · flagged · held** (or request more info). Each disposition writes to the `orders` table and emits an `activity_log` entry that flows through the existing realtime feed. Downstream modules (Fulfillment Queue, Stock, Post-Shipment) are out of scope; they consume approved orders in their own plans.

## Decisions

| Question | Decision |
|---|---|
| Where do orders come from? | New `orders` table in Supabase, seeded with 8 mock rows. Real Shopify integration deferred to its own plan. |
| What states exist? | Four: `pending` (default), `approved`, `flagged`, `held`. Three disposition buttons transition state and each writes an `activity_log` row (`order_approve`, `order_flag`, `order_hold`). A fourth "Need Info" button writes `order_need_info` **without** changing status — it's a nudge, not a state change. |
| Address verdict / freight / map | All static, stored on the order. No external APIs in this plan. Map is a CSS placeholder. |
| QUO messaging + review notes | Notes column with autosave on blur. QUO is an external link button (`Open QUO ↗`) — no iframe, no composer. |
| Sidebar filtering | Status tabs only: Pending · Held · Flagged · All. Search within active tab filters by customer name / order_ref / email. No country or risk filters in v1. |
| Cross-reviewer visibility | Realtime via Supabase `postgres_changes` subscription — other reviewers see dispositioned orders disappear from their pending list within ~1s. |

## Data model

New migration adds one table. No other schema changes.

```sql
create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_ref     text unique not null,
  status        text not null default 'pending'
                check (status in ('pending','approved','flagged','held')),

  customer_name  text not null,
  customer_email text,
  customer_phone text,                       -- E.164 if known
  quo_thread_url text,                       -- external link; null if not provisioned

  address_line   text not null,
  city           text not null,
  region_state   text,
  country        text not null check (country in ('US','CA')),
  address_verdict text not null
                  check (address_verdict in ('house','apt','remote','condo')),

  freight_estimate_usd  numeric(10,2) not null,
  freight_threshold_usd numeric(10,2) not null,

  total_usd     numeric(10,2) not null,
  line_items    jsonb not null default '[]'::jsonb,   -- [{sku,name,qty,price_usd}]

  notes         text not null default '',
  dispositioned_by uuid references auth.users(id),
  dispositioned_at timestamptz,

  created_at    timestamptz not null default now()
);

create index idx_orders_status_created on public.orders (status, created_at desc);

alter table public.orders enable row level security;
create policy "orders_select" on public.orders for select to authenticated using (true);
create policy "orders_update" on public.orders for update to authenticated using (true);

alter publication supabase_realtime add table public.orders;
```

**Why one shared table, no per-row owner:** order triage is a team queue, not assigned work. Any reviewer should be able to read and disposition any pending order. RLS policies are deliberately permissive for this module; tightening (e.g., admin-only flag reversal) can be added later if ops processes require it.

**What's deliberately missing (YAGNI):**

- No `shopify_order_id` / source_channel columns. One column when we need one.
- No `approved_orders` or `fulfillment_queue` table. Approved orders just flip status; Fulfillment plan will add whatever queue-specific state it needs.
- No `order_notes` table — a single notes column is enough. If we ever want multi-author threaded notes, we can migrate.
- No audit trail beyond `activity_log`. If we need immutable per-column history, we add a trigger-based audit log in its own plan.

### Seed data

Separate migration (`<ts>_seed_orders.sql`) inserts 8 orders. Intentional spread:

- 6 `pending`, 1 `flagged`, 1 `held` (so the sidebar tabs each show content on first load)
- 5 US, 3 CA
- 2 with `address_verdict='apt'` or `'condo'` (red verdict banner)
- 1 with `freight_estimate_usd > freight_threshold_usd` (cost bar crosses threshold line)
- Realistic-ish names, addresses, and `line_items` with 1–3 SKUs each

Values are hand-crafted, not generated — the point is to make the UI look alive, not to stress-test.

## File structure

```
app/src/modules/OrderReview/
  index.tsx              default export; layout shell + selection state
  OrderReview.module.css crimson/navy palette, sidebar widths, card styling
  Sidebar.tsx            status tabs + search + order list
  OrderRow.tsx           one row: country flag, tags, selected/flagged border
  Detail.tsx             right-side panel composer
  detail/
    CustomerCard.tsx     name, email, phone, "Open QUO ↗" link (noop if quo_thread_url null)
    AddressCard.tsx      address + verdict banner (house=green / apt=red / remote/condo=amber) + map placeholder
    FreightCard.tsx      cost bar + threshold marker
    LineItemsCard.tsx    table of line_items
    NotesCard.tsx        textarea; autosaves notes on blur
    ActionBar.tsx        Confirm · Flag · Hold · Need Info buttons
    ConfirmBanner.tsx    shown 3s after a disposition action

app/src/lib/
  orders.ts              useOrders(), useOrder(id), disposition(), updateNotes()
  orders.test.ts         vi.hoisted-mocked supabase; covers disposition + notes

supabase/migrations/
  <timestamp>_orders.sql
  <timestamp>_seed_orders.sql
```

**Boundaries:**

- `lib/orders.ts` owns all DB access. Components never import `supabase` directly.
- `OrderReview/index.tsx` owns selection state and routing (`/order-review/<id>`).
- Detail cards are pure UI: receive an `order` prop, render; they do not subscribe or mutate directly. `ActionBar` calls the `disposition()` function passed in via prop, keeping the tree testable without a live DB.

**File-size guard:** target ≤150 lines per TSX file. If `index.tsx` creeps past that, extract the routing/selection logic into a custom hook.

## Data flow + hooks

```ts
// lib/orders.ts

type Order = { /* matches table columns */ };
type OrderStatus = 'pending' | 'approved' | 'flagged' | 'held';

export function useOrders():
  { pending: Order[]; held: Order[]; flagged: Order[]; loading: boolean };

export function useOrder(id: string | null):
  { order: Order | null; loading: boolean };

export async function disposition(
  id: string,
  status: 'approved' | 'flagged' | 'held',
  reason?: string,
): Promise<void>;

export async function needInfo(id: string, note?: string): Promise<void>;
// Same shape as disposition but writes activity_log type='order_need_info' and
// leaves status='pending' (Need Info is a nudge, not a state change).

export async function updateNotes(id: string, notes: string): Promise<void>;
```

**`useOrders()` implementation outline:**

- Initial query: `SELECT * FROM orders ORDER BY created_at DESC` (no LIMIT — expect <500 rows in v1; paginate when we see >1000).
- Realtime subscription on `postgres_changes` for the `orders` table, any event. On any change, replace the local cache row by `id`.
- Derived lists (`pending`, `held`, `flagged`) computed from the cache via `useMemo`. Approved orders drop off the lists.

**`disposition(id, status, reason?)` writes both:**

1. `UPDATE orders SET status, dispositioned_by=auth.uid(), dispositioned_at=now() WHERE id=$1` — persisted state first
2. Activity log second, using verb-form types matching the shared-infra spec §2.3: status `approved` → `order_approve`, `flagged` → `order_flag`, `held` → `order_hold`. `logAction(type, order_ref, reason ?? customer_name)`.

Both failures are surfaced to the caller. If the UPDATE succeeds but `logAction` fails (e.g., realtime blip), we accept a missing log row rather than rolling back the disposition — the DB is authoritative, the activity feed is a convenience.

**`updateNotes(id, notes)`:** single UPDATE, no activity log entry (per-keystroke noise would drown the feed).

## UI behavior

**Selection state:** URL-driven. `/order-review` → auto-select first pending. `/order-review/:id` → select that order. After a disposition, the dispositioned row drops from the active tab; selection jumps to the next order in the current tab list (or empty state if none).

**Sidebar tabs:** Pending (default), Held, Flagged, All. Tab count badges next to each label. Search box filters the active tab only.

**Row indicators (OrderRow):**

- Country flag chip (`tag-ca` crimson / `tag-us` US-navy)
- Status indicators: `apt`/`condo`/`remote` get an amber `warn` tag; `house` stays unmarked
- `.selected`: crimson left border, dark-red background
- `.flagged`: red left border, slightly darker background
- Row body: name (primary), order_ref + city (secondary), freight chip if over threshold

**Detail cards:**

- **CustomerCard** — name, email, phone. `Open QUO ↗` button visible only if `quo_thread_url` is set; opens in new tab (`target="_blank" rel="noopener noreferrer"`).
- **AddressCard** — address line + verdict banner in three color variants (green/red/amber). Map is a CSS gradient placeholder — same visual as the mockup.
- **FreightCard** — horizontal bar filled to `freight_estimate_usd / (freight_threshold_usd * 1.25)`; vertical red marker at threshold; green fill if under, red fill if over.
- **LineItemsCard** — SKU · name · qty · price, one row per line item. Total at bottom matches `total_usd`.
- **NotesCard** — `<textarea>` bound to local state; on blur, if value changed, calls `updateNotes`. No debounced-keystroke saves — keystroke saves would compete with other reviewers' realtime edits.
- **ActionBar** — four buttons: Confirm (green), Flag (red outline), Hold (amber outline), Need Info (grey outline). Clicking Confirm fires immediately. Clicking Flag/Hold/Need Info toggles the button into an inline-expanded state (same row grows to include a one-line reason input + "Submit" / "Cancel" buttons); the action only fires on Submit. Reason is required for Flag, optional for Hold and Need Info.
- **ConfirmBanner** — `display: flex` for 3s after a disposition then auto-dismisses. Shows the action verb and customer name; has a manual close button.

**Empty states:**

- Sidebar no-orders-in-tab: "No orders in this tab."
- No order selected (shouldn't happen with default selection, but guard it): "Select an order from the left to review."

## Testing

**Unit (Vitest):** `orders.test.ts` — uses the same `vi.hoisted(() => {...})` pattern as `activityLog.test.ts` (vitest hoists `vi.mock` above module-scope declarations). Covers:

- `disposition(id, 'approved')` issues an UPDATE with the right payload AND calls `logAction('order_approve', …)`.
- `disposition()` surfaces the error if the UPDATE fails.
- `disposition()` throws if unauthenticated (`supabase.auth.getUser()` returns null).
- `updateNotes` issues an UPDATE and does NOT call `logAction`.

**Component (Vitest + @testing-library/react):**

- `Sidebar.test.tsx` — rows rendered for the active tab only; tab click switches the list; search filters in-list.
- `Detail.test.tsx` — each of the four action buttons invokes `disposition`/`needInfo` with the right status; textarea fires `updateNotes` on blur only.

**E2E (Playwright, against seeded local Supabase):** one happy-path scenario. A seeded test user is inserted via SQL in `beforeAll` against the linked local DB (sidesteps OAuth).

1. Visit `/order-review` → sidebar shows ≥3 pending orders.
2. Click the first row → right panel populates (customer name visible).
3. Click **Confirm** → banner shows; row drops from sidebar; URL updates to next pending.
4. Navigate to `/activity-log` → new `order_approve` entry at the top.

**Deferred (not in this plan):**

- Realtime cross-session propagation — verified manually with two browsers, same approach as the Activity Log.
- Snapshot/visual tests for card rendering edge cases.
- CI e2e integration (needs `supabase start` step in GitHub Actions).

## Done criteria

The module is done when all of the following hold against `https://lila.vip/`:

1. `orders` table exists with RLS enabled, seeded with 8 rows, `UPDATE` and `INSERT` subject to realtime.
2. `/order-review` renders the sidebar with pending orders on top; selecting a row renders the detail panel.
3. Confirm / Flag / Hold each disposition the selected order and log to `activity_log`; Need Info logs without status change.
4. Notes autosave on textarea blur; no activity_log noise.
5. Cross-reviewer realtime works: with two signed-in browsers open, dispositioning an order in A makes it disappear from A's and B's sidebar within ~1s.
6. All unit + component + e2e tests green in CI (unit/component) and locally (e2e).
7. Deploy to `https://lila.vip/` succeeds.

## Next steps

1. Invoke `superpowers:writing-plans` to turn this design into a task-by-task implementation plan at `docs/2026-04-17-make-lila-order-review-plan.md`.
2. Execute that plan on `main` (same pattern as shared-infra; each task = one commit).
3. Deploy; tag `v0.2.0-order-review`.
