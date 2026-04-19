# Make Lila — Fulfillment Module Design (Queue + Shelf)

> Follow-on to `2026-04-17-make-lila-order-review-design.md` (shipped as `v0.2.0-order-review`). This design scopes the **Fulfillment Queue + Shelf** sub-tabs of the Fulfillment module. Remaining sub-tabs (History, Replacements, Returns) are deferred to their own plans. Implementation plan is written separately.

## Goal

Replace the Fulfillment placeholder module with two working sub-tabs:

- **Fulfillment Queue** — per-order 5-step state machine (Assign Unit → Test Report → Ship Label → Dock Check → Send Email → Fulfilled). Orders auto-enqueue when Order Review approves them.
- **Shelf** — physical-layout view of 150 inventory slots (30 skids × 5 slots/skid), drag-and-drop rearrangement, open-reworks panel.

Each step transition writes to `activity_log` and updates the relevant table in real time. Orders progress through the queue; units progress through the shelf (available → reserved → empty once fulfilled, or → rework if flagged during Step 2). Customer-facing shipment emails are sent via the Resend transactional API, from `support@lilacomposter.com`.

## Decisions

| Question | Decision |
|---|---|
| Sub-tabs in scope | Queue + Shelf. History / Replacements / Returns deferred. |
| Queue population | Auto-enqueue via DB trigger on `orders.status` → `'approved'`. |
| Shelf size | 30 skids × 5 slots = 150 positions. Fixed topology. |
| Slot layout per skid | Top row: 3 portrait slots (aspect 4:6). Bottom row: 2 landscape slots (aspect 6:4). Reflects physical 4'×4' skid geometry. |
| Initial inventory | Seed 150 P100 units `LL01-00000000001` … `LL01-00000000150`, all `available`. P100 batch arrived Apr 13, 2026. |
| Drag-drop persistence | Swaps persist immediately to DB. "Confirm layout" button is a UX checkpoint that logs `shelf_layout_saved` to activity_log. |
| Step 2 test report | Optional URL field (`text_report_url`) + reviewer affirmation. No structured test data in MVP. |
| Rework flow | Order drops back to Step 1; unit's shelf slot flips to `rework`; new row in `unit_reworks` table; Reworks panel on Shelf tab lets Aaron/Junaid mark as resolved → slot flips back to `available`. |
| Step 3 ship label | Manual carrier + tracking entry; optional PDF upload to Supabase Storage (`order-labels` bucket). No OCR. |
| Step 4 dock check | 4-item checklist (printed · affixed · docked · notified); each toggle writes immediately; all four required to advance. |
| Step 5 email send | Supabase Edge Function `send-fulfillment-email` calls Resend API. From `support@lilacomposter.com` (sender domain verified via SPF+DKIM in GoDaddy DNS). |
| Starter kit | US orders require a separate `starter_tracking_num` in Step 5; CA orders skip. |
| Email body template | Plain text (no HTML). Subject: `Your LILA Pro has shipped! (<order_ref>)`. Body interpolates customer first name, tracking, carrier, optional starter tracking. |
| Auto-assign logic | Preview only. Fulfillment team must explicitly approve via Step 1's "Confirm assignment" button. |

## Data model

Three new tables, one new trigger, one new storage bucket. No changes to existing `orders`.

```sql
-- Fulfillment queue row — one per approved order, state machine (step 1–6).
create table public.fulfillment_queue (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  step smallint not null default 1 check (step between 1 and 6),

  -- Step 1
  assigned_serial text references public.shelf_slots(serial) on delete set null,

  -- Step 2
  test_report_url text,
  test_confirmed_at timestamptz,
  test_confirmed_by uuid references auth.users(id),

  -- Step 3
  carrier text check (carrier in ('UPS','FedEx','Purolator','Canada Post')),
  tracking_num text,
  label_pdf_path text,
  label_confirmed_at timestamptz,
  label_confirmed_by uuid references auth.users(id),

  -- Step 4
  dock_printed  boolean not null default false,
  dock_affixed  boolean not null default false,
  dock_docked   boolean not null default false,
  dock_notified boolean not null default false,
  dock_confirmed_at timestamptz,
  dock_confirmed_by uuid references auth.users(id),

  -- Step 5 (US-only starter tracking)
  starter_tracking_num text,
  email_sent_at timestamptz,
  email_sent_by uuid references auth.users(id),

  -- Step 6
  fulfilled_at timestamptz,
  fulfilled_by uuid references auth.users(id),

  due_date date,
  created_at timestamptz not null default now()
);

create index idx_fulfillment_queue_due on public.fulfillment_queue (due_date asc);
create index idx_fulfillment_queue_step on public.fulfillment_queue (step);

-- Shelf slots — 150 fixed positions.
-- Slot-index convention: 0,1,2 = top (portrait), 3,4 = bottom (landscape).
create table public.shelf_slots (
  skid       text not null,
  slot_index smallint not null check (slot_index between 0 and 4),
  serial     text unique,
  batch      text,
  status     text not null default 'empty'
             check (status in ('available','reserved','rework','empty')),
  updated_at timestamptz not null default now(),
  primary key (skid, slot_index)
);

-- Rework audit log.
create table public.unit_reworks (
  id bigserial primary key,
  serial text not null,
  skid text, slot_index smallint,
  order_id uuid references public.orders(id),
  issue text not null,
  flagged_by uuid not null references auth.users(id),
  flagged_by_name text not null,
  flagged_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id),
  resolved_by_name text,
  resolved_at timestamptz,
  resolution_notes text
);

-- Trigger: auto-enqueue on approve.
create function public.auto_enqueue_approved_order() returns trigger as $$
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    insert into public.fulfillment_queue (order_id, due_date)
    values (new.id, (now() + interval '7 days')::date)
    on conflict (order_id) do nothing;
  end if;
  return new;
end $$ language plpgsql;

create trigger auto_enqueue_on_approve
  after update of status on public.orders
  for each row execute function public.auto_enqueue_approved_order();

-- RLS: authenticated team read + write on all three tables (mirrors orders).
-- Realtime: all three tables added to supabase_realtime publication.
```

### Storage bucket

`order-labels`, private. Path: `<order_id>/label-<timestamp>.pdf`. RLS: authenticated read + write, anon denied.

### Seed data

`<ts>_seed_shelf_p100.sql`:
- Inserts 150 slots across 30 skids (`A1`–`A30`), distributing serials `LL01-00000000001` – `LL01-00000000150` with batch `P100`, status `available`. Each skid gets 5 consecutive serials (A1 → 1–5, A2 → 6–10, …).

## File structure

```
app/src/modules/Fulfillment/
  index.tsx                    default export; tabs (Queue · Shelf) + active-tab routing
  Fulfillment.module.css       shared palette, step-bar, skid-card styles

  queue/
    index.tsx                  sidebar + right step-view composer
    QueueSidebar.tsx           deadline-sorted list of in-flight queue rows
    QueueHeader.tsx            customer · order_ref · due date · step progress bar
    StepAssign.tsx             Step 1 — pick a serial from shelf
    StepTest.tsx               Step 2 — link test report + confirm / flag rework
    StepLabel.tsx              Step 3 — carrier + tracking + optional PDF upload
    StepDock.tsx               Step 4 — 4-item checklist
    StepEmail.tsx              Step 5 — starter tracking (US only) + send button
    StepFulfilled.tsx          Step 6 — terminal success view

  shelf/
    index.tsx                  grid of skids + confirm-layout button + reworks panel
    SkidCard.tsx               one skid: 3 portrait top + 2 landscape bottom
    Slot.tsx                   single slot: serial + batch + status color
    ReworksPanel.tsx           open-reworks list with "Mark resolved" buttons

app/src/lib/
  fulfillment.ts               all DB/edge-fn access: hooks + action functions
  fulfillment.test.ts          vi.hoisted-mocked; state transitions + rework flow

supabase/migrations/
  <ts>_shelf_slots.sql                 (must run before fulfillment_queue — FK target)
  <ts>_fulfillment_queue.sql           (includes auto-enqueue trigger)
  <ts>_unit_reworks.sql
  <ts>_seed_shelf_p100.sql
  <ts>_order_labels_bucket.sql

supabase/functions/
  send-fulfillment-email/
    index.ts                   Deno edge fn: builds email, POSTs to Resend API

docs/
  2026-04-19-make-lila-fulfillment-design.md   (this file)
  2026-04-19-make-lila-fulfillment-plan.md     (written next)
  fulfillment-email-setup.md                   (Resend signup + DNS + API key)
```

**File-size guard:** ≤150 lines per TSX file, ≤250 for `lib/fulfillment.ts`.

## Data flow + hooks

`lib/fulfillment.ts` exports:

```ts
// Types
export type FulfillmentQueueRow = { /* mirrors fulfillment_queue columns */ };
export type ShelfSlot = {
  skid: string; slot_index: number;
  serial: string | null; batch: string | null;
  status: 'available' | 'reserved' | 'rework' | 'empty';
  updated_at: string;
};
export type UnitRework = { /* mirrors unit_reworks columns */ };

// Hooks
export function useFulfillmentQueue(): {
  all: FulfillmentQueueRow[];
  ready: FulfillmentQueueRow[];     // step 1-5
  fulfilled: FulfillmentQueueRow[]; // step 6
  loading: boolean;
};
export function useShelf(): { slots: ShelfSlot[]; loading: boolean };
export function useOpenReworks(): { reworks: UnitRework[]; loading: boolean };

// Step actions — each advances or transitions state atomically
export async function assignUnit(queueId: string, serial: string): Promise<void>;
export async function confirmTestReport(queueId: string, testReportUrl?: string): Promise<void>;
export async function flagRework(queueId: string, serial: string, issue: string): Promise<void>;
export async function confirmLabel(
  queueId: string,
  input: { carrier: string; tracking_num: string; label_pdf?: File },
): Promise<void>;
export async function toggleDockCheck(queueId: string, field: 'printed'|'affixed'|'docked'|'notified'): Promise<void>;
export async function confirmDock(queueId: string): Promise<void>;
export async function setStarterTracking(queueId: string, starter_tracking_num: string): Promise<void>;
export async function sendFulfillmentEmail(queueId: string): Promise<{ email_id: string }>;

// Shelf actions
export async function swapSlots(
  a: { skid: string; slot_index: number },
  b: { skid: string; slot_index: number },
): Promise<void>;
export async function confirmShelfLayout(): Promise<void>;

// Rework actions
export async function resolveRework(reworkId: number, notes?: string): Promise<void>;
```

### Per-step data flow

```
orders.status = 'approved'
   │
   ▼ trigger auto_enqueue_approved_order
fulfillment_queue row inserted (step=1, due_date=+7d)
   │
   ▼ Step 1: assignUnit(queueId, serial)
queue.assigned_serial set; shelf_slot.status='reserved'; step=2; log fq_assign
   │
   ▼ Step 2: confirmTestReport(queueId, url?)
test_report_url + test_confirmed_*; step=3; log fq_test_ok
   │  (alt: flagRework(queueId, serial, issue) — step→1, slot→rework, log fq_test_flagged)
   ▼ Step 3: confirmLabel(queueId, { carrier, tracking, label_pdf? })
PDF → storage; carrier/tracking saved; step=4; log fq_label_confirmed
   │
   ▼ Step 4: toggleDockCheck × 4 → confirmDock
dock_confirmed_*; step=5; log fq_dock_confirmed
   │
   ▼ Step 5: (US only) setStarterTracking; sendFulfillmentEmail
Resend send; email_sent_*; step=6; fulfilled_*; log fq_email_sent + fq_fulfilled
   │
   ▼ Step 6: terminal. Sidebar badge green.
```

### Activity-log event types

`fq_assign` · `fq_test_ok` · `fq_test_flagged` · `fq_label_confirmed` · `fq_dock_confirmed` · `fq_email_sent` · `fq_fulfilled` · `shelf_layout_saved` · `rework_resolved`

## Per-step UX

### Sidebar (shared across all steps)

- Sort: `due_date` ascending.
- Row cues:
  - Red left border + "⏰ Due TODAY" if `due_date === today`
  - Amber if `due_date` within 2 days
  - Green dot if `step === 6`
- Step badge: `1/6` … `6/6` pill.

### Step 1 — Assign Unit (`StepAssign.tsx`)

- Header: "Assign a tested unit from the shelf."
- Grid of `status='available'` slots: skid label · short-serial · batch chip. Sorted by batch (FIFO).
- Auto-suggested serial (front-row-first logic) is **pre-highlighted**; reviewer can override by clicking any other slot.
- **Confirm assignment** button (green) fires `assignUnit(queueId, serial)` → advances to Step 2. Never auto-commits.

### Step 2 — Test Report (`StepTest.tsx`)

- Header: "Verify the test report for unit `<serial>`."
- Input: **Test report URL** (optional).
- **✓ Test passed — proceed** (green) → `confirmTestReport(queueId, url)` → Step 3.
- **⚑ Flag to Aaron/Junaid** (red outline) → inline reason textarea → **Submit** → `flagRework(queueId, serial, issue)`.
  - Order drops to Step 1. Unit flips to `rework`. New row in `unit_reworks`.
  - Success banner: "Flagged unit `<serial>` for rework. Pick a new unit."

### Step 3 — Ship Label (`StepLabel.tsx`)

- Header: "Attach the shipping label details."
- **Carrier** dropdown: UPS · FedEx · Purolator · Canada Post.
- **Tracking number** text input.
- **Label PDF** file upload (optional). Filename + Remove shown after selection; upload happens on Confirm.
- **Confirm label** button: disabled until carrier + tracking present. Click → `confirmLabel(queueId, {...})` → Step 4.

### Step 4 — Dock Check (`StepDock.tsx`)

- Header: "Dock handoff checklist."
- 4 checkboxes — each toggle writes immediately:
  - ☐ Label printed
  - ☐ Label affixed to box
  - ☐ Box on the outbound dock
  - ☐ Carrier notified for pickup
- **Confirm dock → proceed to Step 5** button: disabled until all 4 checked. Click → `confirmDock(queueId)` → Step 5.

### Step 5 — Send Email (`StepEmail.tsx`)

- Header: "Send the shipment-confirmation email to the customer."
- If country = US: required input **Starter-kit tracking number** (blocks send until filled). CA orders skip this field.
- Read-only preview of the email as it will be sent.
- **Send email** button → `sendFulfillmentEmail(queueId)` → on success, Step 6. Error banner if Resend fails.

### Step 6 — Fulfilled (`StepFulfilled.tsx`)

- Header: green "✓ Fulfilled · `<date> · by <name>`".
- Order summary card: customer, address, serial shipped, carrier + tracking, starter tracking if US, email send receipt.
- Two secondary buttons: **Copy handoff ref** (`<queue_id>-<base36>`) and **Open customer email thread** (mailto).
- No more editing. Row stays in sidebar (green badge).

## Shelf UX + drag-drop

### Grid layout

- 30 skid cards in 5 columns × 6 rows. Page scrolls vertically.
- Each card ~200px wide × ~140px tall.
- Summary bar above grid: "150 slots · X available · Y reserved · Z rework · W empty" + **Confirm layout** button + **Auto-assign next → `<serial>`** preview.

### Skid card anatomy (`SkidCard.tsx`)

Physical layout — 3 portrait on top, 2 landscape on bottom, fitting a 4'×4' footprint:

```
┌─ A7 ────────────┐
│ ┌──┐ ┌──┐ ┌──┐ │
│ │ 0│ │ 1│ │ 2│ │   ← portrait (aspect 4:6),
│ │  │ │  │ │  │ │      slot indexes 0,1,2
│ └──┘ └──┘ └──┘ │
│ ┌─────┐ ┌─────┐│
│ │  3  │ │  4  ││   ← landscape (aspect 6:4),
│ └─────┘ └─────┘│      slot indexes 3,4
└─────────────────┘
```

CSS `aspect-ratio` on each slot: portrait slots have `aspect-ratio: 4/6`; landscape slots have `aspect-ratio: 6/4`.

### Slot appearance (`Slot.tsx`)

- Background color by status:
  - `available` → green
  - `reserved` → amber
  - `rework` → red
  - `empty` → grey dashed outline
- Content (if occupied): last-5-digits of serial top, batch chip bottom. Full serial + skid+slot in tooltip.
- `draggable={status !== 'empty'}`. Empty slots are valid drop targets.

### Drag-drop (HTML5 DnD API, no library)

- `dragstart`: stash `{skid, slot_index}` in `dataTransfer` + local state, apply `.dragging` class.
- `dragover`: `preventDefault()` + `.dropTarget` class on target.
- `drop`: `swapSlots(source, target)` — atomic DB swap. Local UI re-renders on realtime.
- Dragging a `reserved` slot is allowed (rearranging physical inventory doesn't invalidate the queue's `assigned_serial` reference — only the serial itself matters, not the position).

### Confirm layout button (3 states, per spec)

- Grey / disabled: no swap since last confirm (tracked in local state).
- Green / active: one or more swaps since last confirm → on click, `confirmShelfLayout()` logs `shelf_layout_saved` → button flips to Saved.
- Faded green + "Saved ✓": just confirmed. Next swap flips it back to green.
- **Important:** swaps persist to DB immediately. This button is a *checkpoint marker* in the activity feed, not a batch commit.

### Auto-assign preview

- Top of grid: "Auto-assign next → `<serial>`". Front-row-first logic (per spec §4.2): for each skid A1…A30, prefer slot 3 or 4 first, else 0/1/2; skip `reserved`/`rework`/`empty`.
- Display-only on Shelf tab. Actual assignment requires a Step 1 Confirm click — never auto-commits.

### Reworks panel (`ReworksPanel.tsx`)

Below the grid:

- Card per open rework: `<serial>` · flagged by `<name>` · `<flagged_at>` · issue text · order that triggered the flag.
- **Mark resolved** button → inline textarea for resolution notes (optional) → **Confirm** → `resolveRework(reworkId, notes)`.
  - Removes row from this panel.
  - Flips shelf slot status back to `available` (green).
- Empty state: "No units pending rework."

## Email integration (Resend)

Documented fully in `docs/fulfillment-email-setup.md`. Summary:

1. Sign up at `resend.com` (free tier: 3000 emails/month).
2. Add domain `lilacomposter.com` → Resend issues SPF TXT + DKIM CNAME × 2 records. Add to GoDaddy DNS. Verify.
3. Create API key (`re_...`). Set via `supabase secrets set RESEND_API_KEY=re_...`.
4. Deploy `send-fulfillment-email` edge function.

### Edge function `send-fulfillment-email`

```ts
// Deno runtime. POST body: { queue_id: string }.
// Gateway verify_jwt = true (caller must be authenticated).
// 1. SELECT queue + joined orders → name, email, order_ref, country, carrier, tracking, starter_tracking.
// 2. Validate: email_sent_at is null; step === 5; US orders require starter_tracking_num.
// 3. Build template A (plain text).
// 4. POST https://api.resend.com/emails with Authorization: Bearer <RESEND_API_KEY>:
//    {
//      from: 'Team Lila <support@lilacomposter.com>',
//      reply_to: 'support@lilacomposter.com',
//      to: [customer_email],
//      subject: `Your LILA Pro has shipped! (${order_ref})`,
//      text: <template>
//    }
// 5. On 2xx: UPDATE queue (email_sent_*, step=6, fulfilled_*) + INSERT activity_log. Return { email_id }.
// 6. On non-2xx: return 502 with Resend's error body.
```

### Email template (plain text)

```
Hi <first_name>,

Your LILA Pro is on the way. Here are your tracking details:

LILA Pro · <carrier>: <tracking_num>
[if US] Starter kit · <carrier>: <starter_tracking_num>

Expected delivery in 3–7 business days.

Questions? Just reply to this email.

Thanks for your order —
Team Lila
support@lilacomposter.com
```

## Testing

### Unit (Vitest + vi.hoisted)

`fulfillment.test.ts` — mirrors `orders.test.ts` pattern:
- `assignUnit` issues paired queue + shelf updates + activity_log.
- `flagRework` inserts rework + flips slot + drops queue to step 1.
- `confirmLabel` handles both paths (with + without PDF upload).
- `confirmDock` requires all 4 booleans.
- `sendFulfillmentEmail` invokes the edge function with the right payload.
- `resolveRework` flips slot back to available.

### Component (Vitest + @testing-library/react)

- `QueueSidebar.test.tsx` — sort by due_date, overdue red border, step badges.
- `StepTest.test.tsx` — test-passed vs flag-rework paths.
- `StepEmail.test.tsx` — US requires starter tracking, CA skips, send button invokes mock.

### E2E (Playwright)

`fulfillment.spec.ts`:
- Unauthed `/fulfillment` redirects to `/login`.
- Unauthed `/fulfillment?tab=shelf` same.

### Manual verification (post-deploy)

1. Approve an order in Order Review → new queue row appears within 1s.
2. Step 1 → assign a serial → Shelf tab shows that slot amber.
3. Step 2 → Flag rework → Reworks panel shows the unit; Step 1 reopens.
4. Walk an order all the way through → email lands in a test mailbox (use your `@virgohome.io` as the customer's email on a seeded test order).
5. `shelf_slots` count stays at 150 throughout (fulfilled units leave the slot empty but the slot row remains).

### Deferred (out of scope for this plan)

- Real OCR for ship-label upload.
- History / Replacements / Returns sub-tabs.
- Starter kit as a separate shelf/inventory concern (treated as free-text for now).
- Multi-unit orders (schema supports only 1 serial per queue row; `line_items[i].qty > 1` not handled).
- Unit-arrival batching UI (new batches require a seed migration today; admin UI is future work).

## Done criteria

1. DB has `fulfillment_queue`, `shelf_slots` (150 P100 seeds across A1–A30), `unit_reworks`, auto-enqueue trigger, `order-labels` bucket — all with RLS and realtime.
2. Approving an order in Order Review auto-creates a queue row within 1s.
3. A reviewer can walk an order through all 5 steps end-to-end; final email sends via Resend + lands in a real mailbox.
4. Rework flagging drops the order back to Step 1 and flips the unit to `rework`; marking it resolved flips the slot back to `available`.
5. Drag-and-drop on Shelf swaps two slots (persisted + realtime); Confirm layout logs to activity feed.
6. All unit + component + e2e tests pass in CI; deploy green at lila.vip.

## Next steps

1. Invoke `superpowers:writing-plans` to turn this design into a task-by-task implementation plan at `docs/2026-04-19-make-lila-fulfillment-plan.md`.
2. Execute that plan on `main` (same pattern as Order Review; each task = one commit).
3. Deploy; tag `v0.3.0-fulfillment-queue-shelf`.
