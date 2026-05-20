# Build Module — Design Spec

**Date:** 2026-05-13
**Status:** Approved scope; ready for plan
**Author:** Huayi + Claude (brainstorming session)

---

## Goal

Add a Build module to makelila that tracks the full China → Canada production pipeline for LILA Pro units: factory POs to Benliang, ocean freight, customs, in-CA receiving, IQC inspection, defect logging, rework, burn-in testing, and release to Fulfillment.

Replaces the Notion Master Issue Log (Kishore + Aaron's IQC log), Pedrum's per-batch tracking spreadsheet, and Junaid's rework notes — bringing the entire pre-fulfillment lifecycle into makelila as the canonical system of record.

## Architecture

Per-batch tracking upstream (factory_orders, freight_shipments); per-unit tracking downstream from CA arrival (existing `units` table + new `build_defects` and `burn_in_tests`). Single page with a Kanban-style Pipeline Board (6 columns: PO/Production · Freight · IQC · Rework · Burn-in · Ready) and right-side slide-over drill-downs for batch detail, unit detail, and defect detail. Workflow is driven by the canonical `units.status` enum (existing) plus auto-triggers that promote/demote unit status based on defect log and burn-in results.

## Tech Stack

- React 19 + TypeScript + Vite (existing app)
- Supabase Postgres + RLS + realtime
- Supabase Storage for IQC defect photos/videos (new `build-attachments` bucket)
- No new third-party dependencies

---

## Section 1: Schema

### `factory_orders`

```sql
create table public.factory_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text unique not null,           -- e.g. 'BL-P100-2026-04-001'
  batch         text not null,                  -- 'P50N','P100','P100X','P200',...
  qty_ordered   int  not null check (qty_ordered > 0),
  unit_cost_usd numeric(10,2),
  manufacturer  text not null default 'Benliang',
  ship_target_date date,                        -- promised ship date
  status text not null default 'placed'
    check (status in ('placed','in_production','ready_to_ship','shipped','cancelled')),
  notes text,
  placed_at timestamptz not null default now(),
  placed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_factory_orders_batch on public.factory_orders(batch);
create index idx_factory_orders_status on public.factory_orders(status);
```

### `freight_shipments`

```sql
create table public.freight_shipments (
  id              uuid primary key default gen_random_uuid(),
  po_id           uuid not null references public.factory_orders(id) on delete cascade,
  carrier         text,                         -- 'CR Express','Yang Ming','MSC',...
  container_no    text,                         -- 'MSCU1234567'
  bill_of_lading  text,
  etd_china       date,
  etd_actual      date,
  eta_canada      date,
  eta_actual      date,
  customs_cleared_at timestamptz,
  arrived_at_warehouse_at timestamptz,
  status text not null default 'booked'
    check (status in ('booked','on_boat','in_customs','in_transit','arrived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_freight_po on public.freight_shipments(po_id);
create index idx_freight_status on public.freight_shipments(status);
```

### `build_defects`

```sql
create table public.build_defects (
  id           uuid primary key default gen_random_uuid(),
  unit_serial  text not null references public.units(serial) on delete cascade,
  category     text not null check (category in (
    'electrical','mechanical','aesthetic','firmware','assembly','packaging',
    'legacy_rework','legacy_iqc_notion','other'
  )),
  subject      text not null,
  description  text,
  severity     text not null default 'medium'
    check (severity in ('critical','high','medium','low')),
  status       text not null default 'open'
    check (status in ('open','in_rework','resolved','accepted_with_note','scrapped')),
  found_by         uuid references auth.users(id),
  found_by_name    text,
  resolved_by      uuid references auth.users(id),
  resolved_by_name text,
  resolution_note  text,
  source_notion_url text,
  found_at     timestamptz not null default now(),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_defects_serial   on public.build_defects(unit_serial);
create index idx_defects_status   on public.build_defects(status) where status in ('open','in_rework');
create index idx_defects_severity on public.build_defects(severity) where status in ('open','in_rework');
```

### `build_attachments`

```sql
create table public.build_attachments (
  id          uuid primary key default gen_random_uuid(),
  defect_id   uuid not null references public.build_defects(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  mime_type   text not null,
  size_bytes  bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id)
);
create index idx_attachments_defect on public.build_attachments(defect_id);
```

### `burn_in_tests`

```sql
create table public.burn_in_tests (
  id           uuid primary key default gen_random_uuid(),
  unit_serial  text not null references public.units(serial) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  duration_target_hours int not null default 24,
  result       text check (result in ('pass','fail','aborted')),
  failure_mode text,
  notes        text,
  operator_email text,
  created_at   timestamptz not null default now()
);
create index idx_burnin_serial on public.burn_in_tests(unit_serial);
```

### Storage

`build-attachments` bucket — private, signed-URL access, 25 MB per file, 10 files per defect. MIME allow-list: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`, `video/mp4`, `video/quicktime`, `video/webm`. Policies mirror `ticket-attachments` (authenticated read+write; no anonymous access).

### RLS

All five tables: authenticated team can SELECT, INSERT, UPDATE. No anonymous access. Realtime publication enabled for all five tables.

---

## Section 2: State machine & triggers

### Canonical `units.status` lifecycle through Build

```
                  Build module owns          Fulfillment owns
─────────────────────────────────────────────  ────────────────
in-production → inbound → ca-test → ┬─ rework → ca-test ─┐
                                    └─ (burn-in pass) ───┴→ ready → reserved → shipped
```

### Triggers

1. **`factory_orders.status → 'shipped'`**: validates that at least one `freight_shipments` row exists with `status >= 'on_boat'`.
2. **`freight_shipments.arrived_at_warehouse_at` set**: updates `factory_orders.status` accordingly and increments a per-PO `units_landed_count` summary (computed via a view; no bulk row creation). **Unit rows are NOT pre-created** — `units.serial` is the primary key (text, NOT NULL) and we don't yet know the per-unit serials at warehouse arrival. Instead, Aaron creates each unit row at the IQC station when he physically scans/types a serial via the IQC column's "+ Claim serial for batch X" action. The IQC column shows a counter "N units landed for P100, M serials claimed so far" so Aaron can track progress.
3. **`build_defects` INSERT with `status='in_rework'`**: updates `units.status='rework'`.
4. **`build_defects` UPDATE to `status='resolved'`**: if no remaining `open`/`in_rework` defects for this serial, sets `units.status='ca-test'` (back to inspection).
5. **`burn_in_tests` UPDATE with `result='pass'`**: sets `units.status='ready'`.
6. **`burn_in_tests` UPDATE with `result='fail'`**: auto-inserts a `build_defects` row (`category='electrical'`, `subject='Burn-in failure'`, `severity='high'`, `status='in_rework'`, description copied from `failure_mode`). Trigger 3 then bumps unit to `rework`.

### Hand-off to Fulfillment

When unit reaches `status='ready'`, a "Release to Fulfillment" button on its card creates a `fulfillment_queue` row at Step 1 (Test). Existing Fulfillment flow continues from there. Fulfillment's existing Test step (Aaron's pre-ship check) is preserved — burn-in does not replace it.

### Hand-off from Fulfillment (rework)

Fulfillment Step 1 Test failure currently calls `flagRework` in `lib/fulfillment.ts`, which writes to `unit_reworks`. **This is replaced**: `flagRework` now INSERTs into `build_defects` (`category='assembly'`, `severity='high'`, `status='in_rework'`). Trigger 3 sets `units.status='rework'`. The unit reappears on the Build Pipeline Board's Rework column.

---

## Section 3: UI — Pipeline Board

### Route

`/build`, registered in `App.tsx` between `/fulfillment` and `/post-shipment`. Added to `GlobalNav.tsx` MODULES array.

### Top-level layout

Single-page module. Two stacked sections:

1. **KPI strip** (top): 6 tiles wide
   - Batches in flight (count of `factory_orders` with status in `placed/in_production/ready_to_ship/shipped` and no fully-arrived freight)
   - Units in CA (units with status in `inbound/ca-test/rework`)
   - Open defects (count + critical-severity subcount)
   - Burn-in queue (count of `burn_in_tests` with no `ended_at`)
   - Ready (count of units with `status='ready'`)
   - Avg cycle (median days from `factory_orders.placed_at` to `units.status='ready'` over last 90 days)

2. **Pipeline Board** (Kanban, 6 columns full width):
   - PO/Production · Freight · IQC · Rework · Burn-in · Ready
   - Cards in columns 1–2 are per-batch; columns 3–6 are per-unit
   - Filter chips at top: `All · P50N · P100 · P100X · P200`
   - Search box: by serial, PO number, container number
   - View toggle: Board (default Kanban) vs Table (one long sortable table of all units in Build)
   - Drag-and-drop between adjacent columns where the state transition is valid; invalid moves show a tooltip explanation

### Card content

| Column | Card data |
|---|---|
| PO/Production | Batch · qty progress (`60 / 100 made`) · manufacturer · target ship date · cost |
| Freight | PO ref · carrier · container · ETD→ETA progress bar · status pill |
| IQC | Unit serial · inspector · open-defect count + worst severity |
| Rework | Unit serial · assigned ops · defect summary · age (days in rework) |
| Burn-in | Unit serial · operator · elapsed/target hours · live progress bar |
| Ready | Unit serial · finished date · pass icon · **Release to Fulfillment** action |

### Slide-over detail panels (480px wide, right side)

**Batch Detail** (opened from PO/Production or Freight cards):
- PO header: po_number, batch, qty_ordered, manufacturer, unit_cost_usd, status, notes
- Freight timeline: booked → on_boat → in_customs → in_transit → arrived (with editable dates)
- Unit roll-up table: landed / in IQC / in rework / in burn-in / ready
- Actions: edit PO, edit freight, **Mark Arrived** (sets `arrived_at_warehouse_at`; unit rows are NOT pre-created — see Section 2 trigger 2)

**Unit Detail** (opened from IQC / Rework / Burn-in / Ready cards):
- Unit header: serial, batch, ship_at, current status, color (if set)
- Defects timeline: all `build_defects` for this unit, newest first
  - Each defect: severity pill, category badge, subject, description, photo strip, status transitions
- Burn-in history: list of past `burn_in_tests` (started/ended, result pill, notes)
- Actions: **+ Log defect**, **Start burn-in**, **Release to Fulfillment** (only enabled when status=ready)

**Defect Detail** (drill-in from Unit Detail):
- Subject, category dropdown, severity dropdown, description (markdown rendered)
- Photo/video upload area (reuse `AttachmentStrip` component from Service module)
- Status transitions: open → in_rework → resolved/accepted_with_note/scrapped (resolution_note required for resolved)
- Audit: found_by_name, resolved_by_name, timestamps

### Components

- `app/src/modules/Build/index.tsx` — module shell + KPI strip + filters
- `app/src/modules/Build/PipelineBoard.tsx` — Kanban container + column renderers
- `app/src/modules/Build/cards/BatchCard.tsx` — PO/Production + Freight cards
- `app/src/modules/Build/cards/UnitCard.tsx` — IQC/Rework/Burn-in/Ready cards
- `app/src/modules/Build/panels/BatchDetail.tsx` — slide-over
- `app/src/modules/Build/panels/UnitDetail.tsx` — slide-over
- `app/src/modules/Build/panels/DefectDetail.tsx` — drill-in from UnitDetail
- `app/src/modules/Build/TableView.tsx` — alternate flat-table view
- `app/src/modules/Build/Build.module.css`
- `app/src/modules/Build/NewPOModal.tsx` — "+ New PO" action

### Library

`app/src/lib/build.ts` — types, hooks, mutations:
- Types: `FactoryOrder`, `FreightShipment`, `BuildDefect`, `BurnInTest`, `BuildAttachment`, `DefectCategory`, `DefectSeverity`, `DefectStatus`, `POStatus`, `FreightStatus`
- Hooks: `useFactoryOrders()`, `useFreightShipments()`, `useBuildDefects(unit_serial?)`, `useBurnInTests(unit_serial?)`, `useBuildAttachments(defect_id?)`
- Mutations: `createPO`, `updatePO`, `markPOInProduction`, `markPOShipped`, `createFreight`, `updateFreightStatus`, `markArrived`, `assignSerial`, `logDefect`, `startRework`, `resolveDefect`, `startBurnIn`, `endBurnIn`, `releaseToFulfillment`
- Constants: `DEFECT_CATEGORY_META`, `SEVERITY_META`, `STATUS_META` (priority colors)

---

## Section 4: Migrations

### Migration 1: Schema

`supabase/migrations/<ts>_build_module_schema.sql` — creates 5 tables, indexes, RLS, realtime publication, all 6 triggers documented in Section 2.

### Migration 2: Storage bucket

`supabase/migrations/<ts>_build_attachments_bucket.sql` — creates `build-attachments` bucket with 25 MB cap and MIME allow-list. Policies: authenticated read+write; no anonymous access.

### Migration 3: Legacy `unit_reworks` import

`supabase/migrations/<ts>_import_legacy_reworks.sql`:
```sql
insert into public.build_defects (
  unit_serial, category, subject, description, severity, status,
  found_by, found_by_name, found_at, created_at
)
select
  ur.serial,
  'legacy_rework',
  coalesce(ur.issue, '(no description)'),
  ur.issue,
  'medium',
  'resolved',                              -- all imported as resolved
  ur.flagged_by,
  ur.flagged_by_name,
  ur.created_at,
  ur.created_at
from public.unit_reworks ur
where exists (select 1 from public.units u where u.serial = ur.serial);
```

After import, `unit_reworks` table is left in place but marked read-only via a deprecation comment. No new writes to it.

### Migration 4: Notion Master Issue Log import

Python script (run once after launch), not a SQL migration:
- Reads from Notion collection `27fffbba-4c38-80b2-8271-000b4e49eb65` (Master Issue Log) via the existing Notion MCP integration
- Maps fields: `Issue` → subject, `Description of Issue` → description, `Type of Issue` → category (with mapping table), `Impact` → severity, `Location Where Issue Was Identified` → notes
- For each row, INSERT into `build_defects` with `category='legacy_iqc_notion'`, `status='resolved'`, `source_notion_url=<page_url>`
- Notion-attached photos are linked via URL (not re-uploaded; reference only)

### Migration 5: Code updates

Modify `app/src/lib/fulfillment.ts:flagRework` to insert into `build_defects` instead of `unit_reworks`. Update any UI that displays rework history to read from `build_defects` (currently no such UI exists in production; `unit_reworks` was only written, not read in app code).

`app/src/lib/service.ts:createRepairTicketFromFlag` is unaffected (it links by `fulfillment_queue_id`, not `unit_reworks`).

---

## Section 5: Decisions locked in & deferred items

**Locked decisions (will not revisit during implementation):**

- Scope: full pipeline (PO → Production → Freight → IQC → Rework → Burn-in → Ready)
- Granularity: per-batch upstream, per-unit downstream (split at warehouse arrival)
- UI: Pipeline Board (Kanban) + drill-down slide-overs
- Build replaces Notion Master Issue Log entirely
- Build owns burn-in; Fulfillment keeps its existing pre-ship Test (two distinct tests, two records)
- Schema option B: 5 new tables; `unit_reworks` deprecated to read-only
- Serial assignment happens at IQC station in Canada (Aaron types/scans serials when physically inspecting units that arrived from China)
- Burn-in duration target = 24 hours by default, editable per run
- Photo/video upload reuses Service module's `AttachmentStrip` component pattern
- New `build-attachments` storage bucket; same access pattern as `ticket-attachments`

**Deferred to later iterations:**

- Push fulfillment status back to Benliang's system (BL has no system today; communication is WeChat-based)
- Cost roll-up dashboard (PO cost × landed units → unit landed cost) — useful for finance, not v1
- Per-unit BOM tracking (sub-assembly serials → final unit serial) — out of scope
- ISTA 3A drop-test results capture — tracked offline today
- Automated freight tracking via carrier API (CR Express, MSC, etc.) — manual entry for v1
- Defect category auto-classification (ML on description text) — manual for v1

**Open assumptions to validate post-launch:**

- "Resolved" on a defect auto-bumps unit back to `ca-test` rather than directly to `ready`. This forces re-inspection. Override available via unit detail panel ("release without re-inspect") if needed in practice.
- 24h burn-in default may need tuning based on actual failure rate after first batch.
- Tracking "N units landed for P100, M serials claimed so far" relies on Aaron creating one `units` row per physical unit at IQC. Partial arrivals (e.g. some units lost in transit) simply result in M < expected_qty, surfaced as a discrepancy on the batch detail panel.

---

## Files to create / modify

**Migrations (4 SQL + 1 Python script):**
- `supabase/migrations/<ts>_build_module_schema.sql`
- `supabase/migrations/<ts>_build_attachments_bucket.sql`
- `supabase/migrations/<ts>_import_legacy_reworks.sql`
- `scripts/import-notion-iqc-log.py` (one-shot, not committed migrations)

**Edge functions:** none required for v1.

**App code:**
- `app/src/lib/build.ts` — types, hooks, mutations
- `app/src/modules/Build/index.tsx` — module shell
- `app/src/modules/Build/PipelineBoard.tsx`
- `app/src/modules/Build/TableView.tsx`
- `app/src/modules/Build/cards/BatchCard.tsx`
- `app/src/modules/Build/cards/UnitCard.tsx`
- `app/src/modules/Build/panels/BatchDetail.tsx`
- `app/src/modules/Build/panels/UnitDetail.tsx`
- `app/src/modules/Build/panels/DefectDetail.tsx`
- `app/src/modules/Build/NewPOModal.tsx`
- `app/src/modules/Build/Build.module.css`
- `app/src/App.tsx` — add `/build` route
- `app/src/components/GlobalNav.tsx` — add Build module entry
- `app/src/lib/fulfillment.ts` — modify `flagRework` to write `build_defects` instead of `unit_reworks`
