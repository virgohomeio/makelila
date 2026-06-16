# Junaid — Session Notes for makeLILA Shipping

> Reference for Junaid's Claude Code sessions. Owner: Customer Service (Service module) + Stock module work.
> Read this at session start. Each feature below is a complete shipping brief.
> Last updated 2026-06-07.

## Recent substrate landings (Huayi)

- **2026-06-07 — activity_log entity refs landed** (commits `8d7f630` → `7326f64`, migration `20260607030000_activity_log_entity_refs.sql`). `activity_log` now has typed columns `entity_type` / `entity_id` / `unit_serial` with partial indexes. **For your `UnitTimeline.tsx` (Feature 3):** this is a single `useActivityForEntity({ unitSerial })` call from [lib/activityLog.ts](../../app/src/lib/activityLog.ts) — no JOIN, indexed query, realtime INSERT subscription scoped to that serial. New `EntityType` union is exported from the same file. Already-opted-in unit-scoped events: `stock_status`, `stock_link_customer`, `stock_edit`, `serial_assigned`, `defect_logged`, `burnin_started`, `released_to_fulfillment`, plus the ticket lifecycle events when the ticket is unit-bound. Historical rows pre-migration render without entity badges (forward-only, documented as acceptable). EXPLAIN verified the new index is used.
- **2026-06-07 — RBAC substrate landed** (commits `6cf6f1e` → `5d10e5f`, migration `20260607020000_profiles_role_enum_and_canDo_canView.sql`). `profiles.role` enum is live; `canDo(role, action)` and `canView(role, module)` available from [lib/permissions.ts](../../app/src/lib/permissions.ts); `useAuth()` now exposes `role`. **For your Warranty registration write path:** gate via `canDo(role, 'edit_warranty_registration')` (currently allowed for every operator — symmetric placeholder, tighten if you want manager-only edits). RLS helpers `is_manager()` and `is_finance()` are available for any new table policies you write (e.g. tightening `service_tickets` UPDATE later). Finance role seed is George + Huayi + Julie (yueli@virgohome.io).

## Quick links
- PRD: `docs/PRD-2026-06-06.md`
- Competitive proposal: `docs/competitive-landscape-and-proposal-2026-06-06.md`
- Feature backlog: `docs/feature-backlog-alpha-feedback.md`
- System of record: `docs/system-of-record.md`
- Project conventions: `CLAUDE.md` (root + `app/CLAUDE.md`)

## Your domain

Junaid owns the **Service module** end-to-end: Inbox triage, Support Tickets, Onboarding, Replacement workflow, ticket detail panel, attachment/photo handling, and the Calendly diagnosis booking link operators send to customers for live repair triage. Day-to-day this is the highest-volume module in makeLILA — Quo/OpenPhone inbound messages, Gmail-sourced tickets, customer-submitted service-request form entries, and telemetry-driven alerts all funnel into `service_tickets`. You're the one operator-facing engineer who feels the rough edges first, so anything that moves the needle on triage time, mean-time-to-diagnosis, or warranty disputes lands on your queue.

You also pick up **Stock module** work where it intersects with the repair flow — specifically `units.status` lifecycle, `UnitTimeline.tsx`, and the disposition state machine for returned hardware. Reina owns returns intake and Lezhong owns hardware-side build QC, but both of those flows hand off to/from Service via unit serials, so you are the natural owner of the unit-context layer that joins them. You do **not** touch Finance (refund approvals, QuickBooks, payout reconciliation are restricted to George + Huayi), Marketing/Sales (Pedrum's territory: Klaviyo, Shopify segments, pre-sale CRM), or pre-sale CRM contact dedup (also Pedrum).

When in doubt about ownership: if a row lives in `service_tickets`, `units`, `warranty_registrations`, `build_station_passes`, or `sla_policies`, it's yours. If it touches `refund_*`, `orders.financial_*`, or anything Klaviyo-segment-shaped, escalate.

## How to start a session

1. **Pull main.** `git pull origin main` from the repo root. Check `git status` is clean before touching anything.
2. **Re-read this file end-to-end.** Specs drift; the PRD note above is the source of truth.
3. **Check the feature backlog.** `docs/feature-backlog-alpha-feedback.md` — search for any line tagged `[Junaid]`. New asks land there before they land here.
4. **Boot the dev stack.** `cd app && npm install && npm run dev`. Confirm Supabase env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) and telemetry env vars (`VITE_SUPABASE_TELEMETRY_URL`, `VITE_SUPABASE_TELEMETRY_ANON_KEY`) are present in `app/.env.local`.
5. **Verify migrations are in sync.** `./app/node_modules/.bin/supabase db diff --linked` should show no drift. If it does, ask Huayi before applying.
6. **Pick exactly one feature** from the list below. Each is sized 5h or 15h — pick what fits your session.
7. **State a 1-paragraph plan** before writing code. Include: which migration files you'll add, which `lib/*.ts` you'll touch, which UI files you'll touch, what the verification check is.
8. **Branch.** `git checkout -b junaid/feature-<slug>` from main. Never push to main directly.
9. **Ship.** TDD where you can (component tests with Vitest, RLS-touching code gets an integration test against a Supabase branch).
10. **PR with a checklist.** Verification steps, screenshots if UI, migration list, activity_log call sites.

If you ever can't answer "what changes if this PR ships?" in one sentence — stop and ask.

## Conventions to follow

- **CSS Modules only.** Co-locate `*.module.css` with the component. No inline styles except for trivial overrides (1-2 props max). Tailwind is not in this project — don't add it.
- **`lib/*.ts` is the data layer.** Components never import `supabase` directly. If you need a query, add a typed hook (`useServiceTicket`, `useUnitContext`) or mutation function to the relevant lib. Realtime subscriptions go through Supabase channels inside the hook.
- **`logAction()` on every mutation.** Every state-changing operation calls `logAction(action_type, ref_id, detail)`. Without this you lose the audit trail and break Huayi's upcoming activity_log entity-refs work. Templates: `service_ticket_status_changed`, `unit_status_changed`, `warranty_registered`, `warranty_voided`, etc.
- **Photo/video attachments auto-write a note.** Shipped 2026-06-05. When an attachment is uploaded to a ticket, an auto-note feed entry is inserted by trigger. Don't replicate that logic — reuse the trigger. New attachment surfaces (e.g. unit-side photos under Stock) should follow the same pattern: storage upload → row in attachments table → trigger writes the feed entry.
- **Telemetry Supabase is read-only.** Project `arfdopgbvlfmhmcfghhl`, accessed via `app/src/lib/supabaseTelemetry.ts`. Never write to it from makeLILA. If you need to persist a derived value, copy it into our DB.
- **Migration naming.** `YYYYMMDDHHMMSS_description.sql` — match the format of the latest file. Use the actual UTC timestamp at the moment of writing the migration, not a placeholder.
- **RLS first.** Any new table is `enable row level security` immediately. Service-side reads are gated by `is_internal()` (see `20260604200000_rls_internal_only.sql`). Customer-facing forms write through edge functions, not direct RLS.
- **pg_cron.** Extension is enabled. Jobs go in their own migration. Always include the `cron.unschedule` call alongside `cron.schedule` so re-running the migration doesn't double-schedule.

## Features (7 total, ~75h)

Each brief follows the same template:
- **Goal** — what success looks like in one paragraph
- **Work** — concrete steps, files, columns, FK constraints
- **Validation** — how you'll know it ships clean
- **Watch-outs** — known traps, ordering dependencies
- **Files to load** — what to read into your session before writing code

Listed in dependency order. Do not skip ahead — Feature 4's device-context header reads from Feature 1's warranty entity, Feature 6's auto-ticket logic depends on Feature 4 being live.

---

### Feature 1 — Warranty registration entity (P1, S, 5h)

**Goal.** Today "warranty status" is implicit: any service ticket against a known unit_serial gets treated as in-warranty. That's wrong, and it's the chain-abuse vector we keep papering over — customer requests refund, gets it, places a new order with a different unit, then claims "lifetime warranty via serial swap" three years later. We're shipping a real warranty entity so coverage is queryable, voidable, and explicitly transferred (or not) on replacement.

**Work.**
- New migration: `supabase/migrations/<ts>_warranty_registrations.sql`. Create `public.warranty_registrations`:
  - `id uuid primary key default gen_random_uuid()`
  - `unit_serial text not null unique references public.units(serial)` (one active registration per serial)
  - `customer_id uuid not null references public.customers(id)`
  - `original_order_id uuid references public.orders(id)` (nullable for legacy units)
  - `coverage_tier text not null default 'standard_1y' check (coverage_tier in ('standard_1y', 'extended_2y', 'replacement_no_warranty', 'lifetime_legacy'))`
  - `coverage_start date not null`
  - `coverage_end date generated always as (case coverage_tier when 'standard_1y' then coverage_start + interval '1 year' when 'extended_2y' then coverage_start + interval '2 year' when 'replacement_no_warranty' then coverage_start when 'lifetime_legacy' then date '9999-12-31' end) stored`
  - `parent_registration_id uuid references public.warranty_registrations(id)` (set when this registration is a replacement spawn)
  - `voided_reason text` (nullable; populated when chain-of-custody or fraud breaks)
  - `voided_at timestamptz`
  - `registered_at timestamptz not null default now()`
  - `registered_by uuid references auth.users(id)`
  - Indexes on `customer_id`, `original_order_id`, `parent_registration_id`.
- Auto-create on fulfillment completion. The fulfillment-queue completion trigger (see `20260420310000_sync_unit_on_fulfillment.sql`) currently sets `units.status='shipped'`. Extend it: when a unit transitions to `shipped`, insert a `warranty_registrations` row with `coverage_start = current_date`, `coverage_tier = 'standard_1y'`, `original_order_id` from `fulfillment_queue.order_id`, `customer_id` resolved via `orders.customer_id`. Skip insertion if a row already exists for that serial (idempotency).
- Add `service_tickets.warranty_registration_id uuid references public.warranty_registrations(id)`. Resolve on ticket create by looking up the active registration for the unit_serial.
- Add a `coverage_state` computed value at read time (in `lib/service.ts`, not DB) — `'in_warranty' | 'expired' | 'voided' | 'no_registration'`. Don't materialize this; it changes by elapsed time.
- Replacement flow (`20260604210000_replacement_workflow.sql` already exists): when a replacement unit ships, insert a child `warranty_registrations` row with `parent_registration_id = <original_id>`, `coverage_tier = 'replacement_no_warranty'`. This is the load-bearing rule that closes the chain-abuse vector. The child inherits no coverage — operator must explicitly upgrade if we're honoring goodwill.
- Render a warranty badge in `DeviceContextHeader.tsx` (Feature 4) — green "In warranty (245 days remaining)", amber "Expires in 30 days", red "Expired", grey "No registration", red "Voided: <reason>".
- `lib/service.ts`: add `useWarrantyRegistration(unit_serial)` hook, `voidWarranty(id, reason)` mutation, `extendWarranty(id, new_tier)` mutation. Both mutations log to activity_log.

**Validation.**
- Migration applies clean on a Supabase branch. Re-running is a no-op.
- Backfill script (one-off, not a migration): for every `units.status='shipped'` row, insert a `warranty_registrations` row with `coverage_start` = `units.status_updated_at::date`. Document this in the PR.
- New Vitest: `lib/__tests__/warranty.test.ts` — covers (a) standard 1y math, (b) replacement child has no coverage, (c) voided registration returns `'voided'`, (d) expired registration returns `'expired'`.
- Manual: ship a test fulfillment in dev, verify the row materializes; trigger a replacement, verify the child row is `replacement_no_warranty`.

**Watch-outs.**
- **RBAC profiles dependency.** Huayi is shipping the P1 substrate item (RBAC profiles, see `20260603200000_profiles_is_internal.sql` as the seed). Your `void_warranty` and `extend_warranty` mutations should be gated to George + Julie only. Read his work before writing the RLS policy — don't roll your own role check.
- **Legacy units.** Some units shipped before this entity existed. The backfill should mark `coverage_tier = 'lifetime_legacy'` for any unit shipped before 2026-01-01 with no clear order linkage. Confirm the cutoff with George before backfilling.
- **One-active-per-serial.** The unique constraint on `unit_serial` is intentional. If a serial gets a fresh registration (e.g. refurb resold), the previous one must be voided first. Add this as an explicit step in the refurb flow when you get to it.

**Files to load.**
- `supabase/migrations/20260420190000_stock_batches_units.sql` — units table definition
- `supabase/migrations/20260420310000_sync_unit_on_fulfillment.sql` — existing fulfillment completion trigger
- `supabase/migrations/20260604210000_replacement_workflow.sql` — replacement spawn logic
- `app/src/lib/service.ts` — where the hook + mutations live
- `app/src/modules/Service/TicketDetailPanel.tsx` — where the badge eventually renders (via Feature 4)

**Inspired by.** ServiceWorks / InsightPro warranty-as-entity pattern.

---

### Feature 2 — `units.status` quarantine value (P1, S, 5h) — Stock module

**Goal.** Today returned units land back in `units.status='ready'` after processing, which means they can be re-picked into a fresh outbound shipment with no QC gate. We want a `quarantine` status that's the explicit "this came back, needs inspection, do not ship" state. Default Fulfillment queue queries exclude it; only the disposition flow (Reina's P1 M Returns disposition work) can move a unit out.

**Work.**
- Migration: `<ts>_units_status_quarantine.sql`. Drop and recreate the check constraint on `units.status` to add `'quarantine'`. The existing constraint is `check (status in ('in-production','inbound','ca-test','ready','reserved','rework','shipped','team-test','scrap','lost'))` — see `20260420190000_stock_batches_units.sql:54-58`. New constraint adds `'quarantine'`.
- Pattern for the migration (matches existing style):
  ```sql
  alter table public.units drop constraint units_status_check;
  alter table public.units add constraint units_status_check check (status in (
    'in-production','inbound','ca-test',
    'ready','reserved','rework',
    'shipped','team-test','scrap','lost','quarantine'
  ));
  ```
- Default Fulfillment queue queries must exclude quarantine. Audit `app/src/lib/fulfillment.ts` and `app/src/lib/stock.ts` for any `status = 'ready'` query that should instead be `status in ('ready', ...)` whitelist — make sure quarantine never slips in. Add a comment at each query site.
- Stock module unit detail panel: render quarantine as a distinct visual state (red border, "Quarantined" pill with `status_updated_at`). Add a textarea for `notes` so the inspector can record the quarantine reason inline.
- The transition from `shipped` → `quarantine` happens when Reina's returns intake processes a unit (her P1 M work). Coordinate with her — your migration must land first so her code can write the new value.

**Validation.**
- Existing rows are untouched (no migration of data).
- Re-running the migration is safe: wrap the constraint drop in `if exists`.
- Vitest in `lib/stock.test.ts` covering: (a) ready-only fulfillment query does not return quarantine, (b) updating a unit to quarantine sets `status_updated_at` (via existing `touch_unit_status` trigger).
- Manual: in dev, flip a unit to quarantine via SQL, confirm it disappears from Fulfillment queue and shows the new pill in Stock detail.

**Watch-outs.**
- **State machine.** Quarantine is the parking lot. Out-edges go to `rework | ready | scrap | lost`. Reina's disposition state machine is the canonical mover — do not let operators flip quarantine → ready by hand from the Stock module UI without going through her disposition flow. If you must allow a manual override, gate it to George (RBAC).
- **Existing data.** No backfill needed. New value, no rows use it yet.

**Files to load.**
- `supabase/migrations/20260420190000_stock_batches_units.sql`
- `supabase/migrations/20260420240000_stock_status_rules.sql`
- `app/src/lib/stock.ts`
- `app/src/modules/Stock/UnitTable.tsx`
- `app/src/lib/fulfillment.ts`

---

### Feature 3 — `UnitTimeline.tsx` component (P2, S, 5h) — Stock module

**Goal.** Per-serial audit timeline. Today an operator looking at a unit has to mentally stitch together "when was it built? when was it shipped? has it come back? has it raised tickets?" by clicking through five different tabs. A unified vertical timeline next to the unit detail panel and inside the device-context header makes the unit's life legible at a glance.

**Work.**
- New component: `app/src/components/UnitTimeline.tsx`. Props: `{ unitSerial: string, density?: 'compact' | 'full' }`.
- New hook in `app/src/lib/stock.ts`: `useUnitTimeline(unit_serial)` returns chronological events from:
  - `activity_log` filtered by `entity_type='unit'` and `entity_id=unit_serial`, OR `unit_serial` column directly once Huayi's P2 activity_log entity-refs work lands.
  - `service_tickets` rows (created_at, ticket type, status)
  - `returns` rows (received_at, reason, disposition)
  - `unit_test_reports` rows (electrical pass/fail, mechanical pass/fail) — see `20260603160000_unit_test_reports.sql`
  - `fulfillment_log` rows (shipped event) — see `20260603180000_fulfillment_log.sql`
  - Latest telemetry classification from telemetry Supabase via `lib/supabaseTelemetry.ts` (most recent N events, not the full firehose — pull last 14 days)
- Merge the streams, sort by timestamp descending, render as a vertical timeline with icon + chip + relative time + click-to-detail.
- Event types to render:
  - **built** — unit row created in `units`
  - **qc_passed** / **qc_failed** — from `unit_test_reports`
  - **shipped** — `units.status` → `shipped`
  - **returned** — entry in `returns`
  - **quarantined** — `units.status` → `quarantine`
  - **ticket_opened** / **ticket_resolved**
  - **telemetry_event** — non-OK classifier transition
- Used in two places: (1) Stock/UnitDetail right rail, (2) Device-context header expansion drawer (Feature 4).
- Density modes: `compact` shows last 10 events; `full` shows everything with infinite scroll.
- CSS module: `UnitTimeline.module.css`. Match the existing visual language of `TicketNotes.tsx`.

**Validation.**
- Component renders for a serial with 0 events (empty state), 1 event, 100 events.
- Vitest with mocked hook: shipped + 2 tickets + 1 return renders in correct chronological order.
- Manual: open a high-history serial (e.g. one of the early P100 units), confirm the timeline matches what you'd reconstruct by hand.

**Watch-outs.**
- **Depends on Huayi's P2 activity_log entity-refs work.** Until that ships, you can't filter activity_log by unit_serial cleanly. You have two options: (a) wait, or (b) ship the timeline reading only from `service_tickets`/`returns`/`unit_test_reports`/`fulfillment_log` and add the activity_log source as a follow-up PR. Do (b) if Huayi's work is more than a week out — get visible value sooner.
- **Telemetry rate limiting.** Don't query the telemetry Supabase on every render. Cache in the hook with a 60s stale-while-revalidate.
- **Performance.** For a unit with 1000+ events (theoretical, not realistic yet), don't fetch all at once. Paginate the activity_log query.

**Files to load.**
- `app/src/lib/activityLog.ts`
- `app/src/lib/supabaseTelemetry.ts`
- `app/src/lib/dashboard.ts` — classifier definitions
- `app/src/modules/Service/TicketNotes.tsx` — visual reference for timeline layout
- `supabase/migrations/20260603160000_unit_test_reports.sql`
- `supabase/migrations/20260603180000_fulfillment_log.sql`

---

### Feature 4 — Device-context header on Service tickets (P1, M, 15h) — Service module

**Goal.** This is the biggest payoff on your queue. When an operator opens a ticket today, they see the ticket body and the customer info — they don't see the unit's firmware version, the last technician, prior tickets against this serial, current telemetry state, or warranty status. Every triage starts with five clicks. We're collapsing that into a header strip rendered at the top of `Service/SupportTab` ticket detail and `Service/Repair` (when it lands) detail panels. Field-service playbook from Salesforce Field Service Asset object + Aquant.

**Work.**
- New component: `app/src/components/DeviceContextHeader.tsx`. Props: `{ unitSerial: string, ticketId?: string }`.
- New hook in `app/src/lib/service.ts`: `useDeviceContext(unit_serial)`. Joins:
  - `units` row (firmware_version, electrical_check, mechanical_check, defect_notes, technician, batch — see `20260527180000_units_qc_fields.sql`)
  - Latest telemetry classification from `lib/supabaseTelemetry.ts` (most recent classified state per unit)
  - Count of prior `service_tickets` for the same unit_serial, excluding the current ticket
  - Count of `returns` rows for the same unit_serial
  - Warranty registration (Feature 1) — coverage_state + days remaining
- Chips (left-to-right, all clickable to expand a drawer):
  - **Firmware** — green if current (compare to `firmware_versions.is_current` if Huayi has that table; otherwise hardcode a string for now), amber if N-1, red if older. Hover shows the version string.
  - **Telemetry state** — colored by classifier enum: `DRY_SOIL` (amber), `SOAKED_SOIL` (amber), `NEW_FOOD` (green, info only), `NOT_MIXING` (red), `OPEN_LID` (amber), `NO_BME_DATA` (red), `DIAGNOSE` (red), `OK` (green). Show the state name + minutes since the classification.
  - **Open tickets for this unit** — count with link to filter Service inbox by unit_serial. Excludes the current ticket.
  - **Returns count** — count of prior returns. Click → opens PostShipment with the unit_serial filter.
  - **Warranty badge** — depends on Feature 1. Show coverage tier + days remaining or voided/expired state.
  - **Last technician + last QC date** — small text, no chip.
- Expansion drawer (toggle on chip click): renders `UnitTimeline.tsx` (Feature 3) in compact mode at the bottom of the header.
- Wire into `app/src/modules/Service/TicketDetailPanel.tsx` — render at top, above ticket body. Resolve `unit_serial` from the ticket row; if absent (ticket not associated with a unit), render a placeholder "no unit linked" state with a "Link unit" button.

**Validation.**
- Component renders cleanly for tickets with a linked unit, unlinked tickets, and tickets where the unit has no telemetry data.
- Vitest: mock the hook, verify each chip renders with correct color for the classifier enum.
- E2E test in `app/tests/e2e/service-context-header.spec.ts`: open a ticket with known unit, assert chips render expected text.
- Manual: open 3 real tickets in dev — high-history unit, fresh unit, and a unit that's in DIAGNOSE state — confirm chips light up correctly.

**Watch-outs.**
- **Telemetry latency.** Telemetry classifier runs on a schedule in the other Supabase project. If the most recent classification is >24h old, render the state as grey ("stale") with the timestamp. Don't pretend live data exists.
- **`useDeviceContext` is hot.** This hook runs on every ticket detail open. Memoize aggressively, and use a single combined query rather than five parallel queries — collapse into one Supabase RPC if necessary for perf.
- **NOT_MIXING false positives.** Documented in backlog #70. If telemetry says NOT_MIXING, don't auto-escalate the chip color to "definitely broken" tone — keep it as a warning, not a verdict. Tooltip should say "may be false positive — confirm with diagnosis call."
- **Render order.** This header must render *above* the ticket body and *below* the existing ticket toolbar/back-button strip. Don't push the ticket body so far down that the operator has to scroll to read it. Keep the header to ~80px collapsed.
- **Dependency on Feature 1.** The warranty badge can ship without Feature 1 if you fall back to "no registration" for all units, but the badge is the most visible win — ship Feature 1 first.

**Files to load.**
- `app/src/modules/Service/TicketDetailPanel.tsx`
- `app/src/modules/Service/SupportTab.tsx`
- `app/src/lib/service.ts`
- `app/src/lib/supabaseTelemetry.ts`
- `app/src/lib/dashboard.ts` — classifier definitions (the `DRY_SOIL` / `NOT_MIXING` enum lives here)
- `supabase/migrations/20260527180000_units_qc_fields.sql`

**Inspired by.** Salesforce Field Service Asset object + Aquant device-context diagnosis.

---

### Feature 5 — SLA aging + auto-escalation (P1, M, 15h) — Service module

**Goal.** Tickets currently age silently. Operators decide what's urgent based on memory and feel. We're shipping explicit SLA policies (first response + resolution targets), automated breach detection every 15 minutes via pg_cron, automatic priority escalation when a breach is imminent, and notifications to the assigned owner + George when an SLA fires red. Inspired by Zendesk SLA triggers — with all the Zendesk nuance: *triggers* are event-based and fire instantly on row change; *automations* are time-based and run on a schedule. We're building the automation side here.

**Work.**
- Migration `<ts>_sla_policies.sql`:
  - `public.sla_policies` (id uuid pk, priority text check in (`p1`, `p2`, `p3`), first_response_minutes int not null, resolution_minutes int not null, escalate_to_user_id uuid references auth.users(id), is_active boolean default true, created_at timestamptz default now())
  - Seed three rows: P1 = `60 / 1440` (1h / 24h), P2 = `240 / 4320` (4h / 72h), P3 = `1440 / 10080` (24h / 7d). `escalate_to_user_id` = George's user id (look up via `team_invite_list`).
- Migration `<ts>_service_tickets_sla_fields.sql`:
  - Add `sla_policy_id uuid references public.sla_policies(id)` to `service_tickets`
  - Add `first_response_due_at timestamptz`, `resolution_due_at timestamptz`, `first_responded_at timestamptz`, `resolved_at timestamptz`
  - Add `sla_status text check in ('ok', 'warning', 'breached', 'met') default 'ok'`
  - Trigger on insert: resolve `sla_policy_id` from `priority`, compute `first_response_due_at` and `resolution_due_at` from `created_at` + policy minutes.
  - Trigger on update: when status moves to a "first responded" state (any operator note added), set `first_responded_at`. When status moves to a terminal state (resolved/closed), set `resolved_at` and `sla_status='met'` if both deadlines were honored.
- Migration `<ts>_cron_sla_aging_check.sql`:
  - pg_cron job `sla_aging_check` running `*/15 * * * *`.
  - For each open ticket: if `now() > first_response_due_at` and `first_responded_at is null` → set `sla_status='breached'`. If `now() > first_response_due_at - interval '15 minutes'` → set `sla_status='warning'`. Same logic for resolution.
  - On transition into `breached`, write an `activity_log` row, auto-bump priority (P3 → P2 → P1), and call a notification edge function that emails the owner + George.
  - Pair `cron.schedule` with `cron.unschedule` for idempotent re-runs.
- UI:
  - Add a SLA chip column to the Inbox / SupportTab ticket list. Green `OK`, amber `Warning`, red `Breached`, grey `Met`.
  - Sortable "time to breach" column showing the lesser of (`first_response_due_at - now()`, `resolution_due_at - now()`) for open tickets.
  - In `TicketDetailPanel.tsx`, render the two deadlines explicitly under the ticket header.
- `lib/service.ts`: extend `ServiceTicket` type with the new fields. Add `useSlaStatus(ticket_id)` helper that returns the chip color + label string for consistent rendering.

**Validation.**
- Vitest in `lib/service.test.ts` for the SLA computation logic (pure functions: given created_at + priority, compute the due timestamps).
- Migration applies clean. Re-run is a no-op.
- Manual: create a ticket in dev, set `created_at` back in time via SQL, wait for the cron to fire (or run the job function manually with `select cron.schedule_now('sla_aging_check')`), verify the chip flips and an activity_log entry appears.
- Verify the priority auto-bump only fires once per breach — not on every cron tick.

**Watch-outs.**
- **Business hours.** Right now we're ignoring business hours and computing pure elapsed time. This will fire SLAs on weekends. **Decision:** ship pure-elapsed for v1, document the limitation, and add a business-hours calendar in a follow-up. Confirm with George before deviating.
- **Renotification spam.** The breach notification must fire once per (ticket, deadline) pair, not on every 15-minute cron tick. Use the `sla_status` transition (ok → breached, warning → breached) as the firing edge, not the current value.
- **Priority auto-bump.** The bump should only happen on the *first* breach transition. After that, the ticket stays at the bumped priority. Don't keep bumping every 15 minutes.
- **Holiday handling.** Punt to v2.
- **Edge function for email.** If we don't already have a generic "notify user" edge function, you can call Resend directly from the cron job's PL/pgSQL via `net.http_post` and `private.app_secrets` (see `20260604200050_private_app_secrets.sql` for the secrets table pattern).

**Files to load.**
- `app/src/lib/service.ts`
- `app/src/modules/Service/SupportTab.tsx`
- `app/src/modules/Service/InboxTab.tsx`
- `app/src/modules/Service/TicketDetailPanel.tsx`
- `supabase/migrations/20260512100000_service_module_schema.sql`
- `supabase/migrations/20260512130000_service_pg_cron.sql` — existing cron pattern reference
- `supabase/migrations/20260604200050_private_app_secrets.sql`

**Inspired by.** Zendesk SLA triggers + automations.

---

### Feature 6 — Telemetry-driven ticket auto-create (P1, M, 15h) — Service + Dashboard

**Goal.** Today we wait for the customer to call before we know their unit is misbehaving. With the classifier already running in the telemetry Supabase, we can proactively open a service ticket when a unit holds a non-OK state for longer than a tolerated window. The customer hasn't called yet, but we already have a triage-ready ticket with the unit context (Feature 4) attached. Aquant + Peloton/Rachio-style connected-asset alerting.

**Work.**
- Migration `<ts>_cron_telemetry_ticket_autocreate.sql`:
  - pg_cron job `telemetry_ticket_autocreate` running `*/30 * * * *`.
  - For each unit, look up the most recent telemetry classification (this requires either: a) a Supabase Foreign Data Wrapper to the telemetry project — preferred long-term, or b) an edge function that polls the telemetry project and writes a denormalized `unit_telemetry_state` table in makeLILA every 15 minutes; choose (b) for v1 because the FDW setup is heavier).
  - Edge function `sync-telemetry-state` writes `unit_telemetry_state` (unit_serial pk, classified_state text, state_held_since timestamptz, last_seen_at timestamptz, updated_at timestamptz).
  - The cron job then queries `unit_telemetry_state` for units where the same non-OK state has held for N hours per state:
    - `DIAGNOSE`: 6h
    - `NO_BME_DATA`: 24h
    - `DRY_SOIL`, `SOAKED_SOIL`, `NOT_MIXING`: 48h
    - `OPEN_LID`: 4h (often a real issue)
  - For each qualifying unit, check if an open `service_tickets` row exists with `source='telemetry_auto'` and the same unit_serial — skip if yes.
  - Otherwise, insert a `service_tickets` row with `source='telemetry_auto'`, `priority='p2'`, `classification=<dashboard enum>`, `unit_serial`, `customer_id` resolved via `units.customer_id`, and a system comment: "Auto-created from telemetry: unit has been in `<state>` for `<duration>`."
  - In parallel, fire a `telemetry_status_changed` event via Pedrum's Klaviyo Track API firehose (he's building it — coordinate the event payload schema). Don't block the ticket create if Klaviyo is down.
- Add `service_tickets.source` enum value `'telemetry_auto'` (the column already exists for Quo sourcing — see `20260527210000_service_tickets_quo_source.sql`).
- Operator override: add `customers.telemetry_autoticket_suppress boolean default false`. When true, the cron job skips the customer's units entirely. Use this for known beta participants whose units are intentionally in weird states.
- UI:
  - In `SupportTab.tsx` and ticket detail, render a "Auto-created from telemetry" badge.
  - Inbox filter: "Telemetry-auto only" — quick filter for operators to triage the auto pile.
  - Customer detail panel: toggle for `telemetry_autoticket_suppress` (gated to George + Julie).

**Validation.**
- Run in **shadow mode for two weeks** before turning the writes on. Shadow mode: cron job runs the same query and writes the would-be tickets to `telemetry_autoticket_shadow` table, but doesn't insert into `service_tickets`. After two weeks, review with the team: false positive rate, missed-real-issue rate. Then flip a feature flag to enable real writes.
- Vitest for the duration math (pure function: given a classifier_state and held_since, return whether it qualifies).
- Manual: in dev, seed a unit's `unit_telemetry_state` with `classified_state='DIAGNOSE'` and `state_held_since=now() - interval '7 hours'`. Run the cron job manually. Confirm a ticket appears.
- Verify dedup: run the cron twice in a row, confirm only one ticket exists.

**Watch-outs.**
- **NOT_MIXING false positive rate.** Backlog #70 documents 75% false positive. **Do not turn on auto-tickets for NOT_MIXING until the classifier improves.** Ship the framework with NOT_MIXING disabled at the feature flag layer. Lezhong owns the classifier improvement on the hardware side.
- **Beta unit storm.** First time the writes flip on, half the dev team's beta units will spawn tickets. Either (a) auto-suppress all beta customers before turning on, or (b) bulk-resolve the first wave manually and document. Coordinate with George.
- **Depends on Feature 4** for ticket usability — operator opening an auto-ticket needs the device-context header to triage in <30 seconds. Don't ship this without Feature 4.
- **Depends on Pedrum's Klaviyo Track API firehose** for the event fire. If his work isn't ready, ship the ticket create now and add the Klaviyo event fire as a follow-up. The ticket create is the load-bearing part.
- **Telemetry sync lag.** The `unit_telemetry_state` denorm table is at best 15 minutes stale. Don't claim "real-time" alerting anywhere in copy.

**Files to load.**
- `app/src/lib/dashboard.ts` — classifier enum
- `app/src/lib/dashboard.mixing.test.ts` — existing tests for the classifier
- `app/src/lib/supabaseTelemetry.ts`
- `app/src/lib/service.ts`
- `supabase/migrations/20260527210000_service_tickets_quo_source.sql` — source column pattern
- `supabase/migrations/20260527220000_cron_sync_quo_tickets.sql` — existing cron + edge function pattern
- `supabase/functions/` directory — pattern for the sync-telemetry-state edge function

**Inspired by.** Aquant + Peloton/Rachio connected-asset alerting.

---

### Feature 7 — `build_station_passes` promotion (P2, M, 15h) — Build module (future Lezhong handoff candidate)

**Goal.** Right now per-unit QC lives in single-attempt columns on `units` (electrical_check, mechanical_check, defect_notes, firmware_version, technician — see `20260527180000_units_qc_fields.sql`). That model can't express "this unit failed mechanical, was reworked, then passed on attempt 2" or "two different technicians touched this unit." We promote QC into an event-row table — every station pass is one row, with attempt sequence, defect category, photos, and technician. The existing `units` columns become a denormalized view of the latest pass per station, maintained by trigger. This unlocks Build QC analytics (first-pass-yield, defects by station/technician/batch) and is the substrate for any future hardware MES workflow.

**Work.**
- Migration `<ts>_build_station_passes.sql`:
  - `public.build_station_passes` (id uuid pk, unit_serial text not null references units(serial), station text not null check in (`electrical`, `mechanical`, `firmware_flash`, `final_qa`), pass_status text not null check in (`pass`, `fail`, `incomplete`, `rework`), attempt_seq int not null, defect_category text, defect_notes text, technician_id uuid references auth.users(id), firmware_version text, photo_urls jsonb default '[]'::jsonb, created_at timestamptz default now())
  - Unique constraint on (unit_serial, station, attempt_seq).
  - Index on (unit_serial), (station, pass_status), (technician_id, created_at desc).
  - Trigger on insert: maintain the denormalized columns on `units`. For station=`electrical`, update `units.electrical_check = pass_status`. Same for mechanical. For station=`firmware_flash` with pass, update `units.firmware_version`. The latest row wins.
- Backfill: one-off script (not a migration) — for every `units` row with non-null `electrical_check`, insert a `build_station_passes` row with `attempt_seq=1` and pre-existing values. Document in the PR.
- New component: `app/src/modules/Build/StationPassLogger.tsx`. Mobile-friendly. Big buttons: Pass / Fail / Incomplete / Rework. Defect category dropdown (`solder_issue`, `loose_connection`, `firmware_flash_failed`, `display_issue`, `motor_issue`, `sensor_issue`, `mechanical_alignment`, `other`). Notes textarea. Photo upload via Supabase Storage to `build-attachments` bucket (already exists — see `20260513210000_build_attachments_bucket.sql`). On submit, insert the pass row, log to activity_log.
- New component: `app/src/modules/Build/BuildQCDashboard.tsx`. Three views:
  - Defects by station — bar chart
  - Defects by technician — bar chart with hover for category breakdown
  - First-pass-yield trend — line chart by week, per station
- `lib/build.ts`: `useStationPasses(unit_serial)`, `useBuildQCStats(date_range, batch?)` hooks. `recordStationPass(unit_serial, station, pass_status, ...)` mutation.

**Validation.**
- Migration + backfill apply clean against a Supabase branch.
- Vitest: trigger correctly updates `units.electrical_check` after inserting a pass row.
- Manual: walk through logging 3 attempts for a unit (fail, rework, pass) — confirm `units.electrical_check` reflects the final state and the dashboard shows the three attempts.
- E2E: `app/tests/e2e/station-pass-logger.spec.ts` covers the mobile flow on iPhone viewport.

**Watch-outs.**
- **Lezhong handoff.** This is flagged as a Lezhong feature once he's shipping code — he owns the hardware QC context end-to-end. **Decision:** if Lezhong is online and shipping within the next two weeks, defer this to him entirely and pick a smaller Service item. If not, ship the schema + backfill + StationPassLogger MVP yourself; leave the dashboard for him. The schema is the load-bearing part; the analytics views are valuable but not blocking.
- **Backfill data quality.** Pre-existing `units.electrical_check` values were single-attempt and don't carry timestamp granularity. Backfill those as `attempt_seq=1, created_at=units.created_at`. Document that any analytics on dates before the migration are approximate.
- **Photo upload size.** Cap at 10MB per photo, 5 photos per pass. Server-side validation in the edge function, not just client-side.
- **Trigger ordering.** The denormalization trigger fires on insert. If someone runs an UPDATE on `build_station_passes`, the trigger should also re-derive `units.electrical_check`. Either disallow updates (preferred — passes are immutable events) or handle the update case explicitly.
- **Don't delete the existing columns.** `units.electrical_check`, `units.mechanical_check`, `units.defect_notes`, `units.firmware_version`, `units.technician` stay. They're the denormalized view, and a lot of existing UI reads from them.

**Files to load.**
- `app/src/lib/build.ts`
- `app/src/modules/Build/` directory
- `supabase/migrations/20260513200000_build_module_schema.sql`
- `supabase/migrations/20260513210000_build_attachments_bucket.sql`
- `supabase/migrations/20260527180000_units_qc_fields.sql`

**Inspired by.** Tulip MES station-pass pattern.

---

## Cross-cutting reminders

- **Activity log on every mutation.** This bears repeating because it's the most common miss. Pattern:
  ```ts
  await logAction({
    action_type: 'service_ticket_status_changed',
    ref_id: ticket.id,
    detail: { from: prev_status, to: new_status, unit_serial: ticket.unit_serial }
  });
  ```
  When Huayi's entity-refs work lands, the `ref_id` becomes structured (entity_type + entity_id). Use the new shape once it's in main.
- **Realtime subscriptions.** Service module list views use Supabase realtime to update when other operators change rows. If you add a new column to `service_tickets`, make sure the realtime subscription's column list (if any) is updated.
- **Internal-only by default.** All Service + Stock module routes are behind `ProtectedRoute` and the `is_internal()` RLS check. Customer-facing surfaces (`/return`, `/service-request`, etc.) write through edge functions, never direct RLS.
- **Migration testing.** Apply your migration to a Supabase branch (`supabase db push --linked` after `supabase branches create`). Never push untested SQL to the linked project. Tear down the branch after merging.
- **Calendly diagnosis booking link (#75).** You use this daily for repair scheduling — it's not a feature to build, it's part of your operational workflow. Keep it in mind when copywriting auto-ticket comments: "Reply with this Calendly link if the customer needs a live diagnosis session."

## Photo/video attachment auto-note pattern (shipped 2026-06-05)

When you build new attachment surfaces (e.g. unit-side QC photos in Feature 7), follow the existing pattern instead of reinventing:

1. Upload to a Supabase Storage bucket (`service-attachments`, `build-attachments`).
2. Insert a row in the attachments table (`ticket_attachments`, future `build_pass_attachments`) with the storage path + uploader.
3. Database trigger automatically writes an auto-note feed entry to the parent timeline (`ticket_notes` for tickets, `activity_log` for unit/build events).
4. The UI doesn't need to render the note — the trigger handles the feed entry independently.

See `app/src/modules/Service/AttachmentStrip.tsx` for the reference implementation.

## Quick session start cheat sheet

```
1. cd e:\Claude\makelila && git pull origin main
2. Read docs/session-notes/junaid.md (this file) + check feature backlog for [Junaid] tags
3. Pick ONE feature from the 7 below
4. cd app && npm install && npm run dev
5. Verify Supabase env vars + migration sync (supabase db diff --linked)
6. git checkout -b junaid/feature-<slug>
7. Write 1-paragraph plan: migrations / lib touches / UI touches / verification
8. Ship: TDD where possible, logAction() on mutations, RLS on new tables
9. Test: vitest + manual dev walk-through + e2e if UI-touching
10. PR with verification checklist, screenshots, migration list, activity_log call sites
```

**Dependency order (do not skip):**
1. Warranty registration entity → 2. units.status quarantine → 3. UnitTimeline → 4. Device-context header → 5. SLA aging → 6. Telemetry auto-create → 7. build_station_passes

**Sizing:** Features 1, 2, 3 are 5h each (S). Features 4, 5, 6, 7 are 15h each (M). Total ≈75h.

**Restricted zones (do not touch):** Finance (refund approvals, QuickBooks), Marketing/Sales (Klaviyo segments, Shopify product-side), pre-sale CRM contact dedup. Escalate to George + Huayi (Finance) or Pedrum (Marketing/Sales/CRM).

**Key collaborators:**
- Huayi — RBAC profiles (P1 substrate), activity_log entity refs (P2)
- Reina — Returns disposition state machine (P1 M) — pairs with Feature 2
- Pedrum — Klaviyo Track API firehose — pairs with Feature 6
- Lezhong — hardware QC context — eventual owner of Feature 7

If you can't answer "what changes if this PR ships?" in one sentence — stop and ask.
