# Build Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Build module that tracks the full China → Canada production pipeline (factory PO → freight → IQC → rework → burn-in → ready) and supersedes the Notion Master Issue Log + `unit_reworks` table.

**Architecture:** Five new tables (`factory_orders`, `freight_shipments`, `build_defects`, `build_attachments`, `burn_in_tests`) with auto-triggers that promote/demote `units.status`. UI is a single-page module with a 6-column Kanban Pipeline Board + three slide-over drill-down panels (batch, unit, defect). Photo/video uploads via a new `build-attachments` storage bucket.

**Tech Stack:** React 19 + TypeScript + Vite (existing app), Supabase Postgres + RLS + realtime + Storage. No new third-party dependencies.

**Source spec:** [docs/superpowers/specs/2026-05-13-build-module-design.md](../specs/2026-05-13-build-module-design.md)

**Verification model:** No test suite in this project. Verification per task = `mcp__claude_ai_Supabase__apply_migration` for SQL + `cd app && npm run build` for TypeScript + manual browser check on key user-facing tasks. Each task ends with a single git commit.

**Environment assumptions:**
- Supabase project ref: `txeftbbzeflequvrmjjr` (already linked)
- Use `mcp__claude_ai_Supabase__apply_migration` / `execute_sql` for SQL; SUPABASE_ACCESS_TOKEN is not in shell env
- User commits to `main` directly (no feature branch); deploy auto-fires on push to main via GitHub Pages
- Co-author convention: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## File Structure

### New SQL migrations (3 files)

- `supabase/migrations/20260513200000_build_module_schema.sql` — 5 tables + indexes + RLS + realtime publication + 6 triggers
- `supabase/migrations/20260513210000_build_attachments_bucket.sql` — storage bucket + policies
- `supabase/migrations/20260513220000_import_legacy_reworks.sql` — copy existing `unit_reworks` rows into `build_defects` as resolved

### New app library

- `app/src/lib/build.ts` — types, realtime hooks, mutations, display metadata

### New Build module (10 files)

- `app/src/modules/Build/index.tsx` — module shell + KPI strip + filters
- `app/src/modules/Build/Build.module.css` — module styles
- `app/src/modules/Build/PipelineBoard.tsx` — Kanban container + column renderers
- `app/src/modules/Build/TableView.tsx` — alternate flat-table view
- `app/src/modules/Build/cards/BatchCard.tsx` — PO/Production + Freight cards
- `app/src/modules/Build/cards/UnitCard.tsx` — IQC/Rework/Burn-in/Ready cards
- `app/src/modules/Build/panels/BatchDetail.tsx` — batch slide-over
- `app/src/modules/Build/panels/UnitDetail.tsx` — unit slide-over
- `app/src/modules/Build/panels/DefectDetail.tsx` — defect drill-in panel
- `app/src/modules/Build/NewPOModal.tsx` — "+ New PO" modal

### Modified files

- `app/src/App.tsx` — add `/build` route (protected) between `/fulfillment` and `/post-shipment`
- `app/src/components/GlobalNav.tsx` — add Build module entry
- `app/src/lib/fulfillment.ts` — modify `flagRework` to insert into `build_defects` instead of `unit_reworks`

### One-shot script (not committed as migration)

- `scripts/import-notion-iqc-log.mjs` — pulls Master Issue Log from Notion, writes to `build_defects` with `category='legacy_iqc_notion'`. Run once after launch; not part of automatic migrations.

---

## Task 1: Schema migration — 5 tables + triggers

**Files:**
- Create: `supabase/migrations/20260513200000_build_module_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Build module schema: 5 new tables for the China→CA production pipeline.
-- Pipeline stages: PO → Production → Freight → IQC → Rework → Burn-in → Ready.
-- Per-batch upstream (factory_orders, freight_shipments); per-unit downstream
-- (build_defects, burn_in_tests). Replaces the Notion Master Issue Log and
-- supersedes unit_reworks (kept read-only for historical reference).

-- ============================================================ factory_orders
create table if not exists public.factory_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text unique not null,
  batch         text not null,
  qty_ordered   int  not null check (qty_ordered > 0),
  unit_cost_usd numeric(10,2),
  manufacturer  text not null default 'Benliang',
  ship_target_date date,
  status text not null default 'placed'
    check (status in ('placed','in_production','ready_to_ship','shipped','cancelled')),
  notes text,
  placed_at timestamptz not null default now(),
  placed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_factory_orders_batch on public.factory_orders(batch);
create index if not exists idx_factory_orders_status on public.factory_orders(status);
alter table public.factory_orders enable row level security;
create policy "factory_orders_select" on public.factory_orders for select to authenticated using (true);
create policy "factory_orders_insert" on public.factory_orders for insert to authenticated with check (true);
create policy "factory_orders_update" on public.factory_orders for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.factory_orders;

create or replace function public.touch_factory_orders_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists factory_orders_touch on public.factory_orders;
create trigger factory_orders_touch before update on public.factory_orders
  for each row execute function public.touch_factory_orders_updated_at();

-- ============================================================ freight_shipments
create table if not exists public.freight_shipments (
  id              uuid primary key default gen_random_uuid(),
  po_id           uuid not null references public.factory_orders(id) on delete cascade,
  carrier         text,
  container_no    text,
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
create index if not exists idx_freight_po on public.freight_shipments(po_id);
create index if not exists idx_freight_status on public.freight_shipments(status);
alter table public.freight_shipments enable row level security;
create policy "freight_select" on public.freight_shipments for select to authenticated using (true);
create policy "freight_insert" on public.freight_shipments for insert to authenticated with check (true);
create policy "freight_update" on public.freight_shipments for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.freight_shipments;

create or replace function public.touch_freight_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists freight_touch on public.freight_shipments;
create trigger freight_touch before update on public.freight_shipments
  for each row execute function public.touch_freight_updated_at();

-- ============================================================ build_defects
create table if not exists public.build_defects (
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
create index if not exists idx_defects_serial on public.build_defects(unit_serial);
create index if not exists idx_defects_status on public.build_defects(status)
  where status in ('open','in_rework');
create index if not exists idx_defects_severity on public.build_defects(severity)
  where status in ('open','in_rework');
alter table public.build_defects enable row level security;
create policy "defects_select" on public.build_defects for select to authenticated using (true);
create policy "defects_insert" on public.build_defects for insert to authenticated with check (true);
create policy "defects_update" on public.build_defects for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.build_defects;

create or replace function public.touch_defects_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists defects_touch on public.build_defects;
create trigger defects_touch before update on public.build_defects
  for each row execute function public.touch_defects_updated_at();

-- ============================================================ build_attachments
create table if not exists public.build_attachments (
  id          uuid primary key default gen_random_uuid(),
  defect_id   uuid not null references public.build_defects(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  mime_type   text not null,
  size_bytes  bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id)
);
create index if not exists idx_attachments_defect on public.build_attachments(defect_id);
alter table public.build_attachments enable row level security;
create policy "attachments_select" on public.build_attachments for select to authenticated using (true);
create policy "attachments_insert" on public.build_attachments for insert to authenticated with check (true);
alter publication supabase_realtime add table public.build_attachments;

-- ============================================================ burn_in_tests
create table if not exists public.burn_in_tests (
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
create index if not exists idx_burnin_serial on public.burn_in_tests(unit_serial);
alter table public.burn_in_tests enable row level security;
create policy "burnin_select" on public.burn_in_tests for select to authenticated using (true);
create policy "burnin_insert" on public.burn_in_tests for insert to authenticated with check (true);
create policy "burnin_update" on public.burn_in_tests for update to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.burn_in_tests;

-- ============================================================ TRIGGERS

-- T3: defect inserted with status='in_rework' → unit goes to 'rework'
create or replace function public.defect_promote_unit_rework() returns trigger language plpgsql as $$
begin
  if new.status = 'in_rework' then
    update public.units set status = 'rework' where serial = new.unit_serial;
  end if;
  return new;
end $$;
drop trigger if exists defect_promote_rework on public.build_defects;
create trigger defect_promote_rework after insert on public.build_defects
  for each row execute function public.defect_promote_unit_rework();

-- T4: defect status flipped to 'resolved' (and no other open/in_rework defects
-- remain for this unit) → unit goes back to 'ca-test' for re-inspection
create or replace function public.defect_resolved_check() returns trigger language plpgsql as $$
declare
  open_count int;
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    select count(*) into open_count
      from public.build_defects
      where unit_serial = new.unit_serial
        and status in ('open','in_rework');
    if open_count = 0 then
      update public.units set status = 'ca-test'
        where serial = new.unit_serial
          and status = 'rework';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists defect_resolved on public.build_defects;
create trigger defect_resolved after update on public.build_defects
  for each row execute function public.defect_resolved_check();

-- T5: burn-in test result='pass' → unit goes to 'ready'
create or replace function public.burnin_pass_promote() returns trigger language plpgsql as $$
begin
  if new.result = 'pass' and (old.result is null or old.result is distinct from 'pass') then
    update public.units set status = 'ready' where serial = new.unit_serial;
  end if;
  return new;
end $$;
drop trigger if exists burnin_pass on public.burn_in_tests;
create trigger burnin_pass after update on public.burn_in_tests
  for each row execute function public.burnin_pass_promote();

-- T6: burn-in test result='fail' → auto-create a build_defects row
-- (Trigger T3 then bumps the unit to status='rework' as a downstream effect.)
create or replace function public.burnin_fail_create_defect() returns trigger language plpgsql as $$
begin
  if new.result = 'fail' and (old.result is null or old.result is distinct from 'fail') then
    insert into public.build_defects (
      unit_serial, category, subject, description, severity, status, found_by_name
    ) values (
      new.unit_serial,
      'electrical',
      'Burn-in failure',
      coalesce(new.failure_mode, 'No failure mode provided'),
      'high',
      'in_rework',
      coalesce(new.operator_email, 'burn-in system')
    );
  end if;
  return new;
end $$;
drop trigger if exists burnin_fail on public.burn_in_tests;
create trigger burnin_fail after update on public.burn_in_tests
  for each row execute function public.burnin_fail_create_defect();
```

- [ ] **Step 2: Apply migration via MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with:
- `name`: `build_module_schema`
- `project_id`: `txeftbbzeflequvrmjjr`
- `query`: full SQL above

Expected: returns `{"success": true}` (or similar). No error.

- [ ] **Step 3: Verify via SQL**

Use `mcp__claude_ai_Supabase__execute_sql`:
```sql
select count(*) as table_count from information_schema.tables
  where table_schema='public'
    and table_name in ('factory_orders','freight_shipments','build_defects','build_attachments','burn_in_tests');

select count(*) as trigger_count from pg_trigger
  where tgname in ('defect_promote_rework','defect_resolved','burnin_pass','burnin_fail',
                   'factory_orders_touch','freight_touch','defects_touch');
```

Expected: `table_count=5`, `trigger_count=7` (4 business-logic triggers + 3 touch_updated_at triggers).

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260513200000_build_module_schema.sql
git commit -m @'
feat(build): schema for factory_orders + freight + defects + attachments + burn-in tests

Five tables with RLS, realtime publication, updated_at touch triggers,
and four business-logic triggers that drive the units.status state
machine: defect-insert-rework, defect-resolved-bump-back-to-ca-test,
burnin-pass-to-ready, burnin-fail-auto-creates-defect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2: Storage bucket for IQC attachments

**Files:**
- Create: `supabase/migrations/20260513210000_build_attachments_bucket.sql`

- [ ] **Step 1: Write the migration**

```sql
-- build-attachments bucket: IQC defect photos + videos. Private; access via
-- signed URLs from the app. Authenticated team can read+write; no anonymous
-- access (matches the internal-only nature of the Build module).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'build-attachments',
  'build-attachments',
  false,
  26214400, -- 25 MB
  array[
    'image/jpeg','image/png','image/webp','image/heic','image/heif',
    'video/mp4','video/quicktime','video/webm'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "build_attachments_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'build-attachments');

create policy "build_attachments_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'build-attachments');

create policy "build_attachments_delete_auth" on storage.objects
  for delete to authenticated
  using (bucket_id = 'build-attachments');
```

- [ ] **Step 2: Apply via MCP**

`mcp__claude_ai_Supabase__apply_migration`:
- `name`: `build_attachments_bucket`
- `project_id`: `txeftbbzeflequvrmjjr`
- `query`: full SQL above

- [ ] **Step 3: Verify**

```sql
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'build-attachments';

select policyname from pg_policies
where schemaname='storage' and tablename='objects'
  and policyname like 'build_attachments%';
```

Expected: 1 bucket row, 3 policies.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260513210000_build_attachments_bucket.sql
git commit -m @'
feat(build): build-attachments storage bucket for IQC defect photos

Private 25MB bucket with image+video MIME allow-list. Authenticated-only
read/write/delete (no anonymous access — internal Build module).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3: Import legacy unit_reworks → build_defects

**Files:**
- Create: `supabase/migrations/20260513220000_import_legacy_reworks.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Import existing unit_reworks rows into build_defects with category='legacy_rework'
-- and status='resolved' (treating historical reworks as completed). The
-- unit_reworks table is left in place but deprecated to read-only — no new
-- writes after this point. The flagRework function in app/src/lib/fulfillment.ts
-- will be modified in a later task to write to build_defects instead.

insert into public.build_defects (
  unit_serial,
  category,
  subject,
  description,
  severity,
  status,
  found_by,
  found_by_name,
  resolved_at,
  found_at,
  created_at,
  updated_at
)
select
  ur.serial,
  'legacy_rework',
  coalesce(left(ur.issue, 100), '(no description)'),
  ur.issue,
  'medium',
  'resolved',
  ur.flagged_by,
  ur.flagged_by_name,
  ur.created_at,
  ur.created_at,
  ur.created_at,
  ur.created_at
from public.unit_reworks ur
where exists (select 1 from public.units u where u.serial = ur.serial);

comment on table public.unit_reworks is
  'DEPRECATED 2026-05-13: superseded by public.build_defects. Kept for historical reference only. Do not write new rows.';
```

- [ ] **Step 2: Apply via MCP**

`mcp__claude_ai_Supabase__apply_migration`:
- `name`: `import_legacy_reworks`
- `project_id`: `txeftbbzeflequvrmjjr`
- `query`: full SQL above

- [ ] **Step 3: Verify**

```sql
select
  (select count(*) from public.unit_reworks ur
    where exists (select 1 from public.units u where u.serial = ur.serial)) as expected,
  (select count(*) from public.build_defects where category='legacy_rework') as imported;
```

Expected: `expected = imported`.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260513220000_import_legacy_reworks.sql
git commit -m @'
feat(build): import legacy unit_reworks rows into build_defects

One-time copy of every unit_reworks row (whose unit still exists) into
build_defects with category=legacy_rework, status=resolved. The
unit_reworks table is now deprecated to read-only and will be replaced
by build_defects writes in a follow-up task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4: lib/build.ts — types, hooks, mutations

**Files:**
- Create: `app/src/lib/build.ts`

- [ ] **Step 1: Write the library**

```typescript
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

export type POStatus = 'placed' | 'in_production' | 'ready_to_ship' | 'shipped' | 'cancelled';
export type FreightStatus = 'booked' | 'on_boat' | 'in_customs' | 'in_transit' | 'arrived';
export type DefectCategory =
  | 'electrical' | 'mechanical' | 'aesthetic' | 'firmware'
  | 'assembly' | 'packaging' | 'legacy_rework' | 'legacy_iqc_notion' | 'other';
export type DefectSeverity = 'critical' | 'high' | 'medium' | 'low';
export type DefectStatus = 'open' | 'in_rework' | 'resolved' | 'accepted_with_note' | 'scrapped';
export type BurnInResult = 'pass' | 'fail' | 'aborted';

export type FactoryOrder = {
  id: string;
  po_number: string;
  batch: string;
  qty_ordered: number;
  unit_cost_usd: number | null;
  manufacturer: string;
  ship_target_date: string | null;
  status: POStatus;
  notes: string | null;
  placed_at: string;
  placed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FreightShipment = {
  id: string;
  po_id: string;
  carrier: string | null;
  container_no: string | null;
  bill_of_lading: string | null;
  etd_china: string | null;
  etd_actual: string | null;
  eta_canada: string | null;
  eta_actual: string | null;
  customs_cleared_at: string | null;
  arrived_at_warehouse_at: string | null;
  status: FreightStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BuildDefect = {
  id: string;
  unit_serial: string;
  category: DefectCategory;
  subject: string;
  description: string | null;
  severity: DefectSeverity;
  status: DefectStatus;
  found_by: string | null;
  found_by_name: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  source_notion_url: string | null;
  found_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BuildAttachment = {
  id: string;
  defect_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

export type BurnInTest = {
  id: string;
  unit_serial: string;
  started_at: string;
  ended_at: string | null;
  duration_target_hours: number;
  result: BurnInResult | null;
  failure_mode: string | null;
  notes: string | null;
  operator_email: string | null;
  created_at: string;
};

// ============================================================ Display metadata

export const PO_STATUS_META: Record<POStatus, { label: string; color: string; bg: string }> = {
  placed:         { label: 'Placed',         color: '#2b6cb0', bg: '#ebf8ff' },
  in_production:  { label: 'In production',  color: '#553c9a', bg: '#faf5ff' },
  ready_to_ship:  { label: 'Ready to ship',  color: '#c05621', bg: '#fffaf0' },
  shipped:        { label: 'Shipped',        color: '#276749', bg: '#f0fff4' },
  cancelled:      { label: 'Cancelled',      color: '#a0aec0', bg: '#edf2f7' },
};

export const FREIGHT_STATUS_META: Record<FreightStatus, { label: string; color: string; bg: string }> = {
  booked:      { label: 'Booked',      color: '#2b6cb0', bg: '#ebf8ff' },
  on_boat:     { label: 'On boat',     color: '#553c9a', bg: '#faf5ff' },
  in_customs:  { label: 'In customs',  color: '#c05621', bg: '#fffaf0' },
  in_transit:  { label: 'In transit',  color: '#9a4a0a', bg: '#fff1d6' },
  arrived:     { label: 'Arrived',     color: '#276749', bg: '#f0fff4' },
};

export const DEFECT_CATEGORY_META: Record<DefectCategory, { label: string; color: string; bg: string }> = {
  electrical:        { label: 'Electrical',        color: '#c53030', bg: '#fff5f5' },
  mechanical:        { label: 'Mechanical',        color: '#c05621', bg: '#fffaf0' },
  aesthetic:         { label: 'Aesthetic',         color: '#856a0a', bg: '#fff8d6' },
  firmware:          { label: 'Firmware',          color: '#553c9a', bg: '#faf5ff' },
  assembly:          { label: 'Assembly',          color: '#2b6cb0', bg: '#ebf8ff' },
  packaging:         { label: 'Packaging',         color: '#718096', bg: '#f7fafc' },
  legacy_rework:     { label: 'Legacy rework',     color: '#a0aec0', bg: '#edf2f7' },
  legacy_iqc_notion: { label: 'Legacy IQC (Notion)', color: '#a0aec0', bg: '#edf2f7' },
  other:             { label: 'Other',             color: '#a0aec0', bg: '#edf2f7' },
};

export const SEVERITY_META: Record<DefectSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#a51b1b' },
  high:     { label: 'High',     color: '#9a4a0a' },
  medium:   { label: 'Medium',   color: '#856a0a' },
  low:      { label: 'Low',      color: '#718096' },
};

export const DEFECT_STATUS_META: Record<DefectStatus, { label: string; color: string; bg: string }> = {
  open:               { label: 'Open',               color: '#a51b1b', bg: '#fff5f5' },
  in_rework:          { label: 'In rework',          color: '#c05621', bg: '#fffaf0' },
  resolved:           { label: 'Resolved',           color: '#276749', bg: '#f0fff4' },
  accepted_with_note: { label: 'Accepted',           color: '#856a0a', bg: '#fff8d6' },
  scrapped:           { label: 'Scrapped',           color: '#a0aec0', bg: '#edf2f7' },
};

// ============================================================ Hooks

export function useFactoryOrders(): { orders: FactoryOrder[]; loading: boolean } {
  const [orders, setOrders] = useState<FactoryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('factory_orders')
        .select('*')
        .order('placed_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setOrders(data as FactoryOrder[]);
      setLoading(false);
      ch = supabase
        .channel('factory_orders:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'factory_orders' }, (p) => {
          setOrders(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(o => o.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as FactoryOrder;
              const idx = prev.findIndex(o => o.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, []);
  return { orders, loading };
}

export function useFreightShipments(): { shipments: FreightShipment[]; loading: boolean } {
  const [shipments, setShipments] = useState<FreightShipment[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('freight_shipments')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setShipments(data as FreightShipment[]);
      setLoading(false);
      ch = supabase
        .channel('freight_shipments:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'freight_shipments' }, (p) => {
          setShipments(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(s => s.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as FreightShipment;
              const idx = prev.findIndex(s => s.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, []);
  return { shipments, loading };
}

export function useBuildDefects(unitSerial?: string): { defects: BuildDefect[]; loading: boolean } {
  const [defects, setDefects] = useState<BuildDefect[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase.from('build_defects').select('*').order('found_at', { ascending: false });
      if (unitSerial) q = q.eq('unit_serial', unitSerial);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setDefects(data as BuildDefect[]);
      setLoading(false);
      ch = supabase
        .channel(`build_defects:${unitSerial ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'build_defects' }, (p) => {
          setDefects(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(d => d.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as BuildDefect;
              if (unitSerial && row.unit_serial !== unitSerial) return prev;
              const idx = prev.findIndex(d => d.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [unitSerial]);
  return { defects, loading };
}

export function useBurnInTests(unitSerial?: string): { tests: BurnInTest[]; loading: boolean } {
  const [tests, setTests] = useState<BurnInTest[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase.from('burn_in_tests').select('*').order('started_at', { ascending: false });
      if (unitSerial) q = q.eq('unit_serial', unitSerial);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setTests(data as BurnInTest[]);
      setLoading(false);
      ch = supabase
        .channel(`burn_in_tests:${unitSerial ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'burn_in_tests' }, (p) => {
          setTests(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(t => t.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as BurnInTest;
              if (unitSerial && row.unit_serial !== unitSerial) return prev;
              const idx = prev.findIndex(t => t.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [unitSerial]);
  return { tests, loading };
}

export function useBuildAttachments(defectId: string | null): { attachments: BuildAttachment[]; loading: boolean } {
  const [attachments, setAttachments] = useState<BuildAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!defectId) { setAttachments([]); setLoading(false); return; }
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('build_attachments')
        .select('*')
        .eq('defect_id', defectId)
        .order('uploaded_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setAttachments(data as BuildAttachment[]);
      setLoading(false);
      ch = supabase
        .channel(`build_attachments:${defectId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'build_attachments', filter: `defect_id=eq.${defectId}` },
          (p) => {
            setAttachments(prev => {
              if (p.eventType === 'DELETE' && p.old) return prev.filter(a => a.id !== (p.old as { id: string }).id);
              if (p.new) {
                const row = p.new as BuildAttachment;
                const idx = prev.findIndex(a => a.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [defectId]);
  return { attachments, loading };
}

// ============================================================ Mutations

export async function createPO(input: {
  po_number: string; batch: string; qty_ordered: number;
  unit_cost_usd?: number; manufacturer?: string; ship_target_date?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('factory_orders')
    .insert(input)
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('createPO failed');
  await logAction('po_created', input.po_number, `${input.batch} x${input.qty_ordered}`);
  return { id: data.id as string };
}

export async function updatePOStatus(id: string, status: POStatus): Promise<void> {
  const { error } = await supabase.from('factory_orders').update({ status }).eq('id', id);
  if (error) throw error;
  await logAction('po_status_changed', id, status);
}

export async function createFreight(input: {
  po_id: string; carrier?: string; container_no?: string; etd_china?: string; eta_canada?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('freight_shipments')
    .insert(input)
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('createFreight failed');
  return { id: data.id as string };
}

export async function updateFreightStatus(id: string, status: FreightStatus): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === 'arrived') patch.arrived_at_warehouse_at = new Date().toISOString();
  const { error } = await supabase.from('freight_shipments').update(patch).eq('id', id);
  if (error) throw error;
  await logAction('freight_status_changed', id, status);
}

export async function assignSerial(input: {
  serial: string; batch: string; po_id?: string;
}): Promise<void> {
  // Create unit at IQC station. Trigger units_create_lifecycle_on_ship doesn't
  // fire because we start at 'ca-test', not 'shipped'.
  const { error } = await supabase.from('units').insert({
    serial: input.serial,
    batch: input.batch,
    status: 'ca-test',
  });
  if (error) throw error;
  await logAction('serial_assigned', input.serial, input.batch);
}

export async function logDefect(input: {
  unit_serial: string;
  category: DefectCategory;
  subject: string;
  description?: string;
  severity?: DefectSeverity;
  status?: DefectStatus;
  found_by_name?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('build_defects')
    .insert({
      unit_serial: input.unit_serial,
      category: input.category,
      subject: input.subject,
      description: input.description ?? null,
      severity: input.severity ?? 'medium',
      status: input.status ?? 'in_rework',
      found_by_name: input.found_by_name ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('logDefect failed');
  await logAction('defect_logged', input.unit_serial, input.subject);
  return { id: data.id as string };
}

export async function resolveDefect(id: string, resolution_note: string, resolved_by_name?: string): Promise<void> {
  const { error } = await supabase
    .from('build_defects')
    .update({
      status: 'resolved',
      resolution_note,
      resolved_by_name: resolved_by_name ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
  await logAction('defect_resolved', id, resolution_note.slice(0, 80));
}

export async function startBurnIn(unit_serial: string, duration_target_hours = 24, operator_email?: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('burn_in_tests')
    .insert({
      unit_serial,
      duration_target_hours,
      operator_email: operator_email ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('startBurnIn failed');
  await logAction('burnin_started', unit_serial, `${duration_target_hours}h target`);
  return { id: data.id as string };
}

export async function endBurnIn(id: string, result: BurnInResult, failure_mode?: string, notes?: string): Promise<void> {
  const { error } = await supabase
    .from('burn_in_tests')
    .update({
      result,
      failure_mode: failure_mode ?? null,
      notes: notes ?? null,
      ended_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
  await logAction('burnin_ended', id, result);
}

export async function releaseToFulfillment(unit_serial: string): Promise<void> {
  // Look up the order_id this unit's serial is reserved for (via fulfillment_queue.assigned_serial),
  // OR (more likely at this stage) just mark the unit ready — actual fulfillment_queue row creation
  // happens when an order is approved in Order Review. For v1, "release" just confirms the unit is
  // ready and logs the action. If an open order is waiting for this serial, it gets picked up by
  // the existing fulfillment queue UI.
  const { error } = await supabase.from('units').update({ status: 'ready' }).eq('serial', unit_serial);
  if (error) throw error;
  await logAction('released_to_fulfillment', unit_serial, 'unit ready for fulfillment');
}

export async function attachmentSignedUrl(file_path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('build-attachments')
    .createSignedUrl(file_path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
```

- [ ] **Step 2: Build**

```powershell
cd app
npm run build
cd ..
```

Expected: clean build, no TS errors.

- [ ] **Step 3: Commit**

```powershell
git add app/src/lib/build.ts
git commit -m @'
feat(build): lib with types, realtime hooks, mutations

FactoryOrder / FreightShipment / BuildDefect / BurnInTest / BuildAttachment
types, four realtime hooks (one per table), and mutations covering PO/freight
status changes, serial assignment at IQC, defect logging + resolution, burn-in
start/end, and release-to-fulfillment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5: Module shell + route + nav + CSS + placeholder children

**Files:**
- Create: `app/src/modules/Build/index.tsx`
- Create: `app/src/modules/Build/Build.module.css`
- Create: `app/src/modules/Build/PipelineBoard.tsx` (placeholder)
- Create: `app/src/modules/Build/TableView.tsx` (placeholder)
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/GlobalNav.tsx`

- [ ] **Step 1: Write `Build.module.css`**

```css
.layout {
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  min-height: calc(100vh - 200px);
  overflow: hidden;
}
.header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.kpiStrip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.kpiCard {
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.kpiLabel {
  font-size: 9px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.5px; color: var(--color-ink-subtle);
}
.kpiValue {
  font-size: 22px; font-weight: 800; color: var(--color-ink);
  margin-top: 2px;
}
.kpiSub {
  font-size: 10px; color: var(--color-ink-muted); margin-top: 2px;
}
.filterRow {
  display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
}
.chip {
  border: 1px solid var(--color-border); background: #fff;
  color: var(--color-ink-muted);
  padding: 4px 10px; border-radius: 12px;
  font-size: 10px; font-weight: 600; cursor: pointer;
}
.chip:hover { border-color: var(--color-ink-subtle); color: var(--color-ink); }
.chipActive {
  background: var(--color-crimson); color: #fff; border-color: var(--color-crimson);
}
.search {
  flex: 1; min-width: 200px; margin-left: auto;
  padding: 6px 10px; border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px; font-family: inherit;
}
.viewToggle {
  display: flex; gap: 4px; margin-left: 8px;
}

/* Pipeline Board */
.board {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  padding: 12px;
  flex: 1;
  overflow-x: auto;
  min-height: 500px;
}
.column {
  background: var(--color-surface);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  min-width: 180px;
}
.columnHead {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; font-weight: 800; letter-spacing: 0.3px;
  text-transform: uppercase; color: var(--color-ink-subtle);
}
.columnCount {
  background: var(--color-ink-faint); color: #fff;
  padding: 1px 7px; border-radius: 10px;
  font-size: 10px; font-weight: 700;
}
.columnBody {
  padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
  overflow-y: auto;
  flex: 1;
}

/* Cards */
.card {
  background: #fff; border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  cursor: pointer;
  font-size: 11px;
}
.card:hover { border-color: var(--color-crimson); box-shadow: 0 1px 4px rgba(204,45,48,0.08); }
.cardTitle {
  font-weight: 700; font-size: 12px; color: var(--color-ink);
  margin-bottom: 4px;
}
.cardMono { font-family: ui-monospace, monospace; }
.cardMeta {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 10px; color: var(--color-ink-subtle); margin-top: 4px;
}
.cardProgress {
  height: 4px; background: var(--color-border); border-radius: 2px;
  overflow: hidden; margin-top: 6px;
}
.cardProgressFill {
  height: 100%; background: var(--color-crimson);
}

/* Pills */
.pill {
  display: inline-block;
  font-size: 9px; font-weight: 800;
  padding: 2px 7px; border-radius: 10px;
  letter-spacing: 0.3px; text-transform: uppercase;
}

/* Slide-over detail panel */
.detailOverlay {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 480px;
  background: #fff;
  border-left: 1px solid var(--color-border);
  box-shadow: -4px 0 16px rgba(0,0,0,0.08);
  z-index: 80;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.detailHead {
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
}
.detailTitle {
  font-size: 16px; font-weight: 800; color: var(--color-ink); margin: 0;
}
.detailSub {
  font-family: ui-monospace, monospace;
  font-size: 11px; color: var(--color-ink-subtle); margin-top: 2px;
}
.detailClose {
  background: transparent; border: none; font-size: 18px;
  cursor: pointer; color: var(--color-ink-subtle); line-height: 1;
}
.detailBody {
  flex: 1; overflow-y: auto; padding: 14px 18px 20px;
}
.detailSection { margin-bottom: 16px; }
.detailSectionLabel {
  font-size: 9px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--color-ink-subtle); margin-bottom: 6px;
}
.detailFieldGrid {
  display: grid; grid-template-columns: max-content 1fr;
  gap: 4px 12px; font-size: 12px;
}
.detailFieldLabel { color: var(--color-ink-subtle); font-weight: 600; }
.detailFieldValue { color: var(--color-ink); }

.input, .textarea, .select {
  padding: 6px 9px; font-size: 12px;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  font-family: inherit; width: 100%; background: #fff;
}
.input:focus, .textarea:focus, .select:focus {
  outline: none; border-color: var(--color-crimson);
}
.textarea { resize: vertical; min-height: 70px; }

.btnPrimary {
  background: var(--color-crimson); color: #fff; border: none;
  padding: 7px 14px; border-radius: var(--radius-sm);
  font-size: 11px; font-weight: 700; cursor: pointer;
}
.btnPrimary:hover { background: var(--color-crimson-dark); }
.btnPrimary:disabled { opacity: 0.5; cursor: not-allowed; }
.btnSecondary {
  background: #fff; color: var(--color-ink-muted);
  border: 1px solid var(--color-border);
  padding: 7px 14px; border-radius: var(--radius-sm);
  font-size: 11px; font-weight: 600; cursor: pointer;
}
.btnSecondary:hover { border-color: var(--color-ink-subtle); color: var(--color-ink); }

.actionsRow {
  display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;
}

.empty {
  padding: 40px 20px; text-align: center;
  color: var(--color-ink-subtle); font-size: 13px;
}
.loading {
  padding: 40px; text-align: center;
  color: var(--color-ink-subtle); font-size: 13px;
}

/* Table view */
.tableWrap {
  flex: 1; overflow-y: auto; padding: 12px;
}
.table {
  width: 100%; border-collapse: collapse; font-size: 11px;
}
.table th {
  text-align: left; background: var(--color-surface);
  padding: 7px 10px;
  font-size: 9px; font-weight: 800; letter-spacing: 0.4px;
  text-transform: uppercase; color: var(--color-ink-subtle);
  border-bottom: 1px solid var(--color-border);
}
.table td {
  padding: 8px 10px;
  border-bottom: 1px solid #f0eee8;
  vertical-align: top;
}
.row { cursor: pointer; }
.row:hover { background: rgba(204, 45, 48, 0.04); }
```

- [ ] **Step 2: Write `Build/index.tsx`**

```typescript
import { useMemo, useState } from 'react';
import {
  useFactoryOrders, useFreightShipments, useBuildDefects, useBurnInTests,
} from '../../lib/build';
import { useUnits } from '../../lib/stock';
import { PipelineBoard } from './PipelineBoard';
import { TableView } from './TableView';
import styles from './Build.module.css';

type View = 'board' | 'table';
const BATCH_FILTERS = ['all', 'P50N', 'P100', 'P100X', 'P200'] as const;
type BatchFilter = typeof BATCH_FILTERS[number];

export default function Build() {
  const { orders, loading: oLoading } = useFactoryOrders();
  const { shipments, loading: sLoading } = useFreightShipments();
  const { defects, loading: dLoading } = useBuildDefects();
  const { tests, loading: tLoading } = useBurnInTests();
  const { units, loading: uLoading } = useUnits();
  const [view, setView] = useState<View>('board');
  const [batchFilter, setBatchFilter] = useState<BatchFilter>('all');
  const [search, setSearch] = useState('');

  const stats = useMemo(() => {
    const inFlight = orders.filter(o => ['placed','in_production','ready_to_ship','shipped'].includes(o.status));
    const inFlightBatches = [...new Set(inFlight.map(o => o.batch))];
    const unitsInCA = units.filter(u => ['inbound','ca-test','rework'].includes(u.status)).length;
    const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
    const criticalDefects = openDefects.filter(d => d.severity === 'critical').length;
    const burnInQueue = tests.filter(t => !t.ended_at).length;
    const ready = units.filter(u => u.status === 'ready').length;
    return {
      inFlightCount: inFlight.length,
      inFlightBatches,
      unitsInCA,
      openDefects: openDefects.length,
      criticalDefects,
      burnInQueue,
      ready,
    };
  }, [orders, units, defects, tests]);

  const loading = oLoading || sLoading || dLoading || tLoading || uLoading;

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <div className={styles.kpiStrip}>
          <Kpi label="Batches in flight" value={stats.inFlightCount}
            sub={stats.inFlightBatches.join(' · ') || '—'} />
          <Kpi label="Units in CA" value={stats.unitsInCA} sub="inbound → ready" />
          <Kpi label="Open defects" value={stats.openDefects}
            sub={stats.criticalDefects > 0 ? `${stats.criticalDefects} critical` : 'all <critical'} />
          <Kpi label="Burn-in queue" value={stats.burnInQueue} sub="running" />
          <Kpi label="Ready" value={stats.ready} sub="→ fulfillment" />
        </div>
        <div className={styles.filterRow}>
          {BATCH_FILTERS.map(b => (
            <button
              key={b}
              className={`${styles.chip} ${batchFilter === b ? styles.chipActive : ''}`}
              onClick={() => setBatchFilter(b)}
            >{b === 'all' ? 'All' : b}</button>
          ))}
          <input
            className={styles.search}
            placeholder="Search serial, PO, container…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className={styles.viewToggle}>
            <button
              className={`${styles.chip} ${view === 'board' ? styles.chipActive : ''}`}
              onClick={() => setView('board')}
            >Board</button>
            <button
              className={`${styles.chip} ${view === 'table' ? styles.chipActive : ''}`}
              onClick={() => setView('table')}
            >Table</button>
          </div>
        </div>
      </div>
      {loading ? (
        <div className={styles.loading}>Loading Build pipeline…</div>
      ) : view === 'board' ? (
        <PipelineBoard
          orders={orders}
          shipments={shipments}
          defects={defects}
          tests={tests}
          units={units}
          batchFilter={batchFilter}
          search={search}
        />
      ) : (
        <TableView
          orders={orders}
          shipments={shipments}
          defects={defects}
          tests={tests}
          units={units}
          batchFilter={batchFilter}
          search={search}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Write placeholder `PipelineBoard.tsx`**

```typescript
import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';
import type { Unit } from '../../lib/stock';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function PipelineBoard(_props: Props) {
  return (
    <div className={styles.empty}>
      Pipeline Board — to be implemented in Task 6.
    </div>
  );
}
```

- [ ] **Step 4: Write placeholder `TableView.tsx`**

```typescript
import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';
import type { Unit } from '../../lib/stock';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function TableView(_props: Props) {
  return (
    <div className={styles.empty}>
      Table view — to be implemented in Task 12.
    </div>
  );
}
```

- [ ] **Step 5: Modify `app/src/App.tsx`**

Find the existing routes block (around `<Route path="post-shipment" element={<PostShipment />} />`) and add:
- Import: `import Build from './modules/Build';`
- Route: `<Route path="build" element={<Build />} />` immediately before the `post-shipment` route.

Use Edit tool. Show context:

Old:
```typescript
            <Route path="fulfillment"       element={<Fulfillment />} />
            <Route path="fulfillment/:tab"  element={<Fulfillment />} />
            <Route path="post-shipment" element={<PostShipment />} />
```

New:
```typescript
            <Route path="fulfillment"       element={<Fulfillment />} />
            <Route path="fulfillment/:tab"  element={<Fulfillment />} />
            <Route path="build"         element={<Build />} />
            <Route path="post-shipment" element={<PostShipment />} />
```

And add import:

Old:
```typescript
import Fulfillment from './modules/Fulfillment';
import PostShipment from './modules/PostShipment';
```

New:
```typescript
import Fulfillment from './modules/Fulfillment';
import Build from './modules/Build';
import PostShipment from './modules/PostShipment';
```

- [ ] **Step 6: Modify `app/src/components/GlobalNav.tsx`**

Find the MODULES array, insert `Build` between `Fulfillment` and `Post-Shipment`:

Old:
```typescript
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/post-shipment', label: 'Post-Shipment' },
```

New:
```typescript
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/build',         label: 'Build' },
  { path: '/post-shipment', label: 'Post-Shipment' },
```

- [ ] **Step 7: Build**

```powershell
cd app
npm run build
cd ..
```

Expected: clean build. The placeholder Pipeline Board / Table View renders "to be implemented" text.

- [ ] **Step 8: Manual verify**

`cd app && npm run dev`. Open `http://localhost:5173/build`. Confirm:
- "Build" appears in the top nav between Fulfillment and Post-Shipment
- KPI strip renders (all zeros until data is in)
- Filter chips render
- Board / Table toggle works
- Body shows "Pipeline Board — to be implemented in Task 6."

Stop dev server.

- [ ] **Step 9: Commit**

```powershell
git add app/src/modules/Build app/src/App.tsx app/src/components/GlobalNav.tsx
git commit -m @'
feat(build): module shell + route + nav + CSS + KPI strip

Build module renders at /build with KPI strip (6 tiles), batch filter
chips, search, Board/Table view toggle. Pipeline Board and Table View
are placeholders; filled in by Task 6 and Task 12.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 6: PipelineBoard with 6 columns + card components

**Files:**
- Modify: `app/src/modules/Build/PipelineBoard.tsx`
- Create: `app/src/modules/Build/cards/BatchCard.tsx`
- Create: `app/src/modules/Build/cards/UnitCard.tsx`

- [ ] **Step 1: Write `cards/BatchCard.tsx`**

```typescript
import {
  type FactoryOrder, type FreightShipment,
  PO_STATUS_META, FREIGHT_STATUS_META,
} from '../../../lib/build';
import styles from '../Build.module.css';

type Mode = 'po' | 'freight';

type Props = {
  mode: Mode;
  order: FactoryOrder;
  freight?: FreightShipment;
  unitsMadeCount?: number;
  onClick: () => void;
};

export function BatchCard({ mode, order, freight, unitsMadeCount, onClick }: Props) {
  if (mode === 'po') {
    const meta = PO_STATUS_META[order.status];
    const pct = unitsMadeCount !== undefined && order.qty_ordered > 0
      ? Math.round((unitsMadeCount / order.qty_ordered) * 100)
      : 0;
    return (
      <div className={styles.card} onClick={onClick}>
        <div className={styles.cardTitle}>{order.batch}</div>
        <div className={styles.cardMono} style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>
          {order.po_number}
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 4 }}>
          {unitsMadeCount ?? '?'} / {order.qty_ordered} made · {order.manufacturer}
        </div>
        {unitsMadeCount !== undefined && (
          <div className={styles.cardProgress}>
            <div className={styles.cardProgressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={styles.cardMeta}>
          <span className={styles.pill} style={{ background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
          {order.ship_target_date && (
            <span>ETD {new Date(order.ship_target_date).toLocaleDateString()}</span>
          )}
        </div>
      </div>
    );
  }
  // freight mode
  if (!freight) return null;
  const meta = FREIGHT_STATUS_META[freight.status];
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardTitle}>{order.batch}</div>
      <div className={styles.cardMono} style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>
        {freight.container_no ?? '(no container)'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 4 }}>
        {freight.carrier ?? 'Carrier TBD'}
        {freight.eta_canada && ` · ETA ${new Date(freight.eta_canada).toLocaleDateString()}`}
      </div>
      <div className={styles.cardMeta}>
        <span className={styles.pill} style={{ background: meta.bg, color: meta.color }}>
          {meta.label}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `cards/UnitCard.tsx`**

```typescript
import {
  type BuildDefect, type BurnInTest, SEVERITY_META,
} from '../../../lib/build';
import type { Unit } from '../../../lib/stock';
import styles from '../Build.module.css';

type Mode = 'iqc' | 'rework' | 'burnin' | 'ready';

type Props = {
  mode: Mode;
  unit: Unit;
  defects: BuildDefect[];
  test?: BurnInTest;
  onClick: () => void;
};

export function UnitCard({ mode, unit, defects, test, onClick }: Props) {
  const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
  const worstSeverity = openDefects.reduce<string>((acc, d) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    if (order[d.severity] > (order[acc as keyof typeof order] || 0)) return d.severity;
    return acc;
  }, '');

  let bottom: React.ReactNode = null;
  if (mode === 'iqc') {
    bottom = openDefects.length === 0
      ? <span style={{ color: 'var(--color-success)' }}>Pass — release to burn-in</span>
      : (
        <span>
          {openDefects.length} open
          {worstSeverity && (
            <span className={styles.pill}
              style={{
                marginLeft: 6,
                background: SEVERITY_META[worstSeverity as keyof typeof SEVERITY_META].color,
                color: '#fff',
              }}>
              {SEVERITY_META[worstSeverity as keyof typeof SEVERITY_META].label}
            </span>
          )}
        </span>
      );
  } else if (mode === 'rework') {
    const summary = openDefects[0]?.subject ?? '—';
    const days = Math.floor((Date.now() - new Date(unit.status_updated_at).getTime()) / 86_400_000);
    bottom = <span>{summary} · {days}d in rework</span>;
  } else if (mode === 'burnin') {
    if (test) {
      const elapsedMs = (test.ended_at ? new Date(test.ended_at).getTime() : Date.now())
                        - new Date(test.started_at).getTime();
      const hours = Math.round(elapsedMs / 3_600_000);
      const pct = Math.min(100, Math.round((hours / test.duration_target_hours) * 100));
      bottom = (
        <>
          <span>{hours}h / {test.duration_target_hours}h</span>
          <div className={styles.cardProgress}>
            <div className={styles.cardProgressFill} style={{ width: `${pct}%` }} />
          </div>
        </>
      );
    } else {
      bottom = <span>(no burn-in yet)</span>;
    }
  } else { // ready
    bottom = <span style={{ color: 'var(--color-success)' }}>✓ Ready</span>;
  }

  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardTitle + ' ' + styles.cardMono}>{unit.serial}</div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginTop: 2 }}>
        {unit.batch} {unit.color ? `· ${unit.color}` : ''}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 6 }}>
        {bottom}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Overwrite `PipelineBoard.tsx`**

```typescript
import { useMemo, useState } from 'react';
import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';
import type { Unit } from '../../lib/stock';
import { BatchCard } from './cards/BatchCard';
import { UnitCard } from './cards/UnitCard';
import { BatchDetail } from './panels/BatchDetail';
import { UnitDetail } from './panels/UnitDetail';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function PipelineBoard({ orders, shipments, defects, tests, units, batchFilter, search }: Props) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedUnitSerial, setSelectedUnitSerial] = useState<string | null>(null);

  const filterMatch = (text: string) => !search || text.toLowerCase().includes(search.toLowerCase());

  const cols = useMemo(() => {
    const inProduction = orders.filter(o =>
      (o.status === 'placed' || o.status === 'in_production') &&
      (batchFilter === 'all' || o.batch === batchFilter) &&
      filterMatch(`${o.po_number} ${o.batch}`)
    );
    const inFreight = shipments
      .filter(s => s.status !== 'arrived')
      .map(s => ({ s, o: orders.find(o => o.id === s.po_id) }))
      .filter(x => x.o &&
        (batchFilter === 'all' || x.o.batch === batchFilter) &&
        filterMatch(`${x.o.po_number} ${x.s.container_no ?? ''} ${x.o.batch}`)
      ) as { s: FreightShipment; o: FactoryOrder }[];

    const filteredUnits = units.filter(u =>
      (batchFilter === 'all' || u.batch === batchFilter) &&
      filterMatch(`${u.serial} ${u.batch} ${u.customer_name ?? ''}`)
    );
    const iqc    = filteredUnits.filter(u => u.status === 'inbound' || u.status === 'ca-test');
    const rework = filteredUnits.filter(u => u.status === 'rework');
    const ready  = filteredUnits.filter(u => u.status === 'ready');

    const inBurnIn = tests
      .filter(t => !t.ended_at)
      .map(t => ({ t, u: filteredUnits.find(u => u.serial === t.unit_serial) }))
      .filter(x => x.u) as { t: BurnInTest; u: Unit }[];

    return { inProduction, inFreight, iqc, rework, inBurnIn, ready };
  }, [orders, shipments, units, tests, batchFilter, search]);

  const defectsBySerial = useMemo(() => {
    const m = new Map<string, BuildDefect[]>();
    for (const d of defects) {
      const list = m.get(d.unit_serial) ?? [];
      list.push(d);
      m.set(d.unit_serial, list);
    }
    return m;
  }, [defects]);

  const selectedOrder = selectedOrderId ? orders.find(o => o.id === selectedOrderId) ?? null : null;
  const selectedUnit = selectedUnitSerial ? units.find(u => u.serial === selectedUnitSerial) ?? null : null;

  return (
    <>
      <div className={styles.board}>
        <Column title="PO / Production" count={cols.inProduction.length}>
          {cols.inProduction.map(o => (
            <BatchCard key={o.id} mode="po" order={o}
              unitsMadeCount={units.filter(u => u.batch === o.batch).length}
              onClick={() => setSelectedOrderId(o.id)} />
          ))}
        </Column>
        <Column title="Freight" count={cols.inFreight.length}>
          {cols.inFreight.map(({ s, o }) => (
            <BatchCard key={s.id} mode="freight" order={o} freight={s}
              onClick={() => setSelectedOrderId(o.id)} />
          ))}
        </Column>
        <Column title="IQC" count={cols.iqc.length}>
          {cols.iqc.map(u => (
            <UnitCard key={u.serial} mode="iqc" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Rework" count={cols.rework.length}>
          {cols.rework.map(u => (
            <UnitCard key={u.serial} mode="rework" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Burn-in" count={cols.inBurnIn.length}>
          {cols.inBurnIn.map(({ t, u }) => (
            <UnitCard key={u.serial} mode="burnin" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              test={t}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Ready" count={cols.ready.length}>
          {cols.ready.map(u => (
            <UnitCard key={u.serial} mode="ready" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
      </div>
      {selectedOrder && (
        <BatchDetail
          order={selectedOrder}
          freight={shipments.find(s => s.po_id === selectedOrder.id) ?? null}
          unitsLanded={units.filter(u => u.batch === selectedOrder.batch).length}
          onClose={() => setSelectedOrderId(null)} />
      )}
      {selectedUnit && (
        <UnitDetail
          unit={selectedUnit}
          defects={defectsBySerial.get(selectedUnit.serial) ?? []}
          tests={tests.filter(t => t.unit_serial === selectedUnit.serial)}
          onClose={() => setSelectedUnitSerial(null)} />
      )}
    </>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className={styles.column}>
      <div className={styles.columnHead}>
        <span>{title}</span>
        <span className={styles.columnCount}>{count}</span>
      </div>
      <div className={styles.columnBody}>
        {count === 0 ? <div style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>(empty)</div> : children}
      </div>
    </div>
  );
}
```

Note: this Task 6 references `BatchDetail` and `UnitDetail` panels which are placeholder files for now — they'll be implemented in Tasks 7 and 8.

- [ ] **Step 4: Create placeholder panels**

Create `app/src/modules/Build/panels/BatchDetail.tsx`:
```typescript
import type { FactoryOrder, FreightShipment } from '../../../lib/build';
import styles from '../Build.module.css';

type Props = {
  order: FactoryOrder;
  freight: FreightShipment | null;
  unitsLanded: number;
  onClose: () => void;
};

export function BatchDetail({ order, onClose }: Props) {
  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{order.batch}</h3>
          <div className={styles.detailSub}>{order.po_number}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Batch detail — to be implemented in Task 7.</div>
      </div>
    </div>
  );
}
```

Create `app/src/modules/Build/panels/UnitDetail.tsx`:
```typescript
import type { BuildDefect, BurnInTest } from '../../../lib/build';
import type { Unit } from '../../../lib/stock';
import styles from '../Build.module.css';

type Props = {
  unit: Unit;
  defects: BuildDefect[];
  tests: BurnInTest[];
  onClose: () => void;
};

export function UnitDetail({ unit, onClose }: Props) {
  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle + ' ' + styles.cardMono}>{unit.serial}</h3>
          <div className={styles.detailSub}>{unit.batch} · {unit.status}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Unit detail — to be implemented in Task 8.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build**

```powershell
cd app
npm run build
cd ..
```

Expected: clean build.

- [ ] **Step 6: Manual verify**

`npm run dev`. Open `/build`. Confirm 6 columns render with column counts. Click a card → placeholder detail panel slides in. Close it. Switch to Table view → still placeholder.

- [ ] **Step 7: Commit**

```powershell
git add app/src/modules/Build/PipelineBoard.tsx app/src/modules/Build/cards/ app/src/modules/Build/panels/
git commit -m @'
feat(build): Pipeline Board with 6 columns + Batch/Unit cards

Kanban layout filtered by batch + search. BatchCard shows PO/Freight
state with progress bar; UnitCard shows IQC/Rework/Burn-in/Ready state
with severity pill and burn-in progress. Card click opens slide-over
detail panel (placeholders for Task 7/8).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 7: BatchDetail slide-over panel

**Files:**
- Modify: `app/src/modules/Build/panels/BatchDetail.tsx`

- [ ] **Step 1: Overwrite `BatchDetail.tsx`**

```typescript
import { useState } from 'react';
import {
  type FactoryOrder, type FreightShipment, type POStatus, type FreightStatus,
  PO_STATUS_META, FREIGHT_STATUS_META,
  updatePOStatus, updateFreightStatus, createFreight,
} from '../../../lib/build';
import styles from '../Build.module.css';

type Props = {
  order: FactoryOrder;
  freight: FreightShipment | null;
  unitsLanded: number;
  onClose: () => void;
};

const PO_STATES: POStatus[] = ['placed','in_production','ready_to_ship','shipped','cancelled'];
const FREIGHT_STATES: FreightStatus[] = ['booked','on_boat','in_customs','in_transit','arrived'];

export function BatchDetail({ order, freight, unitsLanded, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const poMeta = PO_STATUS_META[order.status];
  const fMeta = freight ? FREIGHT_STATUS_META[freight.status] : null;

  async function run<T>(p: Promise<T>) {
    setBusy(true); setError(null);
    try { await p; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{order.batch}</h3>
          <div className={styles.detailSub}>{order.po_number} · {order.manufacturer}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Purchase Order</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Qty ordered</span>
            <span className={styles.detailFieldValue}>{order.qty_ordered}</span>
            <span className={styles.detailFieldLabel}>Units landed</span>
            <span className={styles.detailFieldValue}>{unitsLanded}</span>
            <span className={styles.detailFieldLabel}>Unit cost</span>
            <span className={styles.detailFieldValue}>
              {order.unit_cost_usd ? `$${order.unit_cost_usd.toFixed(2)} USD` : '—'}
            </span>
            <span className={styles.detailFieldLabel}>Target ship</span>
            <span className={styles.detailFieldValue}>
              {order.ship_target_date ? new Date(order.ship_target_date).toLocaleDateString() : '—'}
            </span>
            <span className={styles.detailFieldLabel}>Placed</span>
            <span className={styles.detailFieldValue}>{new Date(order.placed_at).toLocaleDateString()}</span>
            <span className={styles.detailFieldLabel}>Status</span>
            <span>
              <span className={styles.pill} style={{ background: poMeta.bg, color: poMeta.color }}>
                {poMeta.label}
              </span>
            </span>
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Advance PO status</div>
          <div className={styles.actionsRow}>
            {PO_STATES.filter(s => s !== order.status).map(s => (
              <button
                key={s}
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => run(updatePOStatus(order.id, s))}
              >→ {PO_STATUS_META[s].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Freight</div>
          {freight ? (
            <>
              <div className={styles.detailFieldGrid}>
                <span className={styles.detailFieldLabel}>Carrier</span>
                <span className={styles.detailFieldValue}>{freight.carrier ?? '—'}</span>
                <span className={styles.detailFieldLabel}>Container</span>
                <span className={`${styles.detailFieldValue} ${styles.cardMono}`}>{freight.container_no ?? '—'}</span>
                <span className={styles.detailFieldLabel}>ETD China</span>
                <span className={styles.detailFieldValue}>
                  {freight.etd_china ? new Date(freight.etd_china).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>ETA Canada</span>
                <span className={styles.detailFieldValue}>
                  {freight.eta_canada ? new Date(freight.eta_canada).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Customs cleared</span>
                <span className={styles.detailFieldValue}>
                  {freight.customs_cleared_at ? new Date(freight.customs_cleared_at).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Arrived</span>
                <span className={styles.detailFieldValue}>
                  {freight.arrived_at_warehouse_at ? new Date(freight.arrived_at_warehouse_at).toLocaleDateString() : '—'}
                </span>
                <span className={styles.detailFieldLabel}>Status</span>
                <span>
                  {fMeta && (
                    <span className={styles.pill} style={{ background: fMeta.bg, color: fMeta.color }}>
                      {fMeta.label}
                    </span>
                  )}
                </span>
              </div>
              <div className={styles.actionsRow}>
                {FREIGHT_STATES.filter(s => s !== freight.status).map(s => (
                  <button
                    key={s}
                    className={styles.btnSecondary}
                    disabled={busy}
                    onClick={() => run(updateFreightStatus(freight.id, s))}
                  >→ {FREIGHT_STATUS_META[s].label}</button>
                ))}
              </div>
            </>
          ) : (
            <div className={styles.actionsRow}>
              <button
                className={styles.btnPrimary}
                disabled={busy}
                onClick={() => run(createFreight({ po_id: order.id }))}
              >+ Add freight shipment</button>
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}

        {order.notes && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Notes</div>
            <div style={{ fontSize: 12, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>{order.notes}</div>
          </div>
        )}

      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 3: Manual verify**

`npm run dev`. Open `/build`. Click a PO card → BatchDetail slides in. Try advancing PO status → state updates in realtime. Add freight shipment → freight section appears. Advance freight status. Confirm "Arrived" sets `arrived_at_warehouse_at`.

- [ ] **Step 4: Commit**

```powershell
git add app/src/modules/Build/panels/BatchDetail.tsx
git commit -m @'
feat(build): Batch detail panel with PO + Freight state transitions

Slide-over panel shows PO summary, freight summary (or "Add freight"
when missing), state-machine-aware advance buttons. Updates flow
through realtime channels so the Pipeline Board reflects changes
immediately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 8: UnitDetail panel + Defect log + Burn-in actions

**Files:**
- Modify: `app/src/modules/Build/panels/UnitDetail.tsx`

- [ ] **Step 1: Overwrite `UnitDetail.tsx`**

```typescript
import { useState } from 'react';
import type { Unit } from '../../../lib/stock';
import {
  type BuildDefect, type BurnInTest,
  SEVERITY_META, DEFECT_CATEGORY_META, DEFECT_STATUS_META,
  logDefect, startBurnIn, endBurnIn, releaseToFulfillment,
} from '../../../lib/build';
import { DefectDetail } from './DefectDetail';
import styles from '../Build.module.css';

type Props = {
  unit: Unit;
  defects: BuildDefect[];
  tests: BurnInTest[];
  onClose: () => void;
};

const CATEGORY_OPTIONS = [
  'electrical','mechanical','aesthetic','firmware','assembly','packaging','other',
] as const;

export function UnitDetail({ unit, defects, tests, onClose }: Props) {
  const [selectedDefectId, setSelectedDefectId] = useState<string | null>(null);
  const [showNewDefect, setShowNewDefect] = useState(false);
  const [newDefect, setNewDefect] = useState({ category: 'mechanical' as typeof CATEGORY_OPTIONS[number], subject: '', description: '', severity: 'medium' as 'critical'|'high'|'medium'|'low' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
  const activeBurnIn = tests.find(t => !t.ended_at) ?? null;

  async function run<T>(p: Promise<T>) {
    setBusy(true); setError(null);
    try { await p; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitNewDefect() {
    if (!newDefect.subject.trim()) { setError('Subject required'); return; }
    await run(logDefect({
      unit_serial: unit.serial,
      category: newDefect.category,
      subject: newDefect.subject,
      description: newDefect.description || undefined,
      severity: newDefect.severity,
      status: 'in_rework',
    }));
    setShowNewDefect(false);
    setNewDefect({ category: 'mechanical', subject: '', description: '', severity: 'medium' });
  }

  const selectedDefect = selectedDefectId ? defects.find(d => d.id === selectedDefectId) ?? null : null;

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={`${styles.detailTitle} ${styles.cardMono}`}>{unit.serial}</h3>
          <div className={styles.detailSub}>{unit.batch} · {unit.status} · {unit.color ?? ''}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Quick actions</div>
          <div className={styles.actionsRow}>
            <button className={styles.btnSecondary} disabled={busy} onClick={() => setShowNewDefect(s => !s)}>
              + Log defect
            </button>
            {!activeBurnIn && openDefects.length === 0 && (
              <button className={styles.btnPrimary} disabled={busy}
                onClick={() => run(startBurnIn(unit.serial, 24))}>
                Start 24h burn-in
              </button>
            )}
            {activeBurnIn && (
              <>
                <button className={styles.btnPrimary} disabled={busy}
                  onClick={() => run(endBurnIn(activeBurnIn.id, 'pass'))}>
                  Burn-in PASS
                </button>
                <button className={styles.btnSecondary} disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Failure mode (required):') ?? '';
                    if (reason) void run(endBurnIn(activeBurnIn.id, 'fail', reason));
                  }}>
                  Burn-in FAIL
                </button>
                <button className={styles.btnSecondary} disabled={busy}
                  onClick={() => run(endBurnIn(activeBurnIn.id, 'aborted'))}>
                  Abort burn-in
                </button>
              </>
            )}
            {unit.status === 'ready' && (
              <button className={styles.btnPrimary} disabled={busy}
                onClick={() => run(releaseToFulfillment(unit.serial))}>
                Release to Fulfillment ✓
              </button>
            )}
          </div>
        </div>

        {showNewDefect && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>New defect</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select className={styles.select}
                value={newDefect.category}
                onChange={e => setNewDefect(s => ({ ...s, category: e.target.value as typeof s.category }))}>
                {CATEGORY_OPTIONS.map(c => (
                  <option key={c} value={c}>{DEFECT_CATEGORY_META[c].label}</option>
                ))}
              </select>
              <select className={styles.select}
                value={newDefect.severity}
                onChange={e => setNewDefect(s => ({ ...s, severity: e.target.value as typeof s.severity }))}>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <input className={styles.input} placeholder="Subject (short)"
                value={newDefect.subject}
                onChange={e => setNewDefect(s => ({ ...s, subject: e.target.value }))} />
              <textarea className={styles.textarea} placeholder="Description (longer)"
                value={newDefect.description}
                onChange={e => setNewDefect(s => ({ ...s, description: e.target.value }))} />
              <div className={styles.actionsRow}>
                <button className={styles.btnPrimary} disabled={busy} onClick={submitNewDefect}>Save defect</button>
                <button className={styles.btnSecondary} disabled={busy} onClick={() => setShowNewDefect(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Defects ({defects.length})</div>
          {defects.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No defects logged.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {defects.map(d => {
                const sm = DEFECT_STATUS_META[d.status];
                const cm = DEFECT_CATEGORY_META[d.category];
                const sev = SEVERITY_META[d.severity];
                return (
                  <div key={d.id}
                    onClick={() => setSelectedDefectId(d.id)}
                    style={{
                      padding: 8, border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                      <span className={styles.pill} style={{ background: cm.bg, color: cm.color }}>{cm.label}</span>
                      <span className={styles.pill} style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                      <span className={styles.pill} style={{ background: sev.color, color: '#fff' }}>{sev.label}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-ink)' }}>{d.subject}</div>
                    {d.description && (
                      <div style={{ fontSize: 11, color: 'var(--color-ink-muted)', marginTop: 2 }}>
                        {d.description.slice(0, 100)}{d.description.length > 100 ? '…' : ''}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginTop: 4 }}>
                      {new Date(d.found_at).toLocaleDateString()} · {d.found_by_name ?? 'system'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Burn-in history ({tests.length})</div>
          {tests.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No burn-in runs yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tests.map(t => {
                const resultColor = t.result === 'pass' ? '#276749'
                                  : t.result === 'fail' ? '#a51b1b'
                                  : t.result === 'aborted' ? '#9a4a0a'
                                  : '#718096';
                return (
                  <div key={t.id} style={{ fontSize: 11, padding: '6px 8px',
                    background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ color: resultColor, fontWeight: 700 }}>{t.result ?? 'running'}</span>
                    {' · '}
                    <span>{new Date(t.started_at).toLocaleDateString()}</span>
                    {t.ended_at && <> → <span>{new Date(t.ended_at).toLocaleDateString()}</span></>}
                    {' · '}
                    <span>{t.duration_target_hours}h target</span>
                    {t.failure_mode && <div style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>{t.failure_mode}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>

      {selectedDefect && (
        <DefectDetail defect={selectedDefect} onClose={() => setSelectedDefectId(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create placeholder `DefectDetail.tsx`**

```typescript
import type { BuildDefect } from '../../../lib/build';
import styles from '../Build.module.css';

type Props = { defect: BuildDefect; onClose: () => void; };

export function DefectDetail({ defect, onClose }: Props) {
  return (
    <div className={styles.detailOverlay} style={{ width: 380, right: 480 }}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{defect.subject}</h3>
          <div className={styles.detailSub}>{defect.category} · {defect.severity}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Defect detail — to be implemented in Task 9.</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 4: Manual verify**

Open `/build`. Click a unit card. Try: + Log defect (mechanical/high/test subject), see it appear in the Defects list. Start burn-in on a clean unit (no open defects). End burn-in PASS → unit promotes to 'ready'. End burn-in FAIL → trigger auto-creates a defect; unit goes to 'rework'.

- [ ] **Step 5: Commit**

```powershell
git add app/src/modules/Build/panels/UnitDetail.tsx app/src/modules/Build/panels/DefectDetail.tsx
git commit -m @'
feat(build): Unit detail panel with defect log + burn-in workflow

Slide-over for a single unit. Quick actions row: Log defect, Start
burn-in (only if no open defects), Pass/Fail/Abort active burn-in,
Release to Fulfillment (when status=ready). Defect list with category
+ severity + status pills; click drills into DefectDetail (placeholder
for Task 9). Burn-in history list with result colors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 9: DefectDetail with photo upload + status transitions

**Files:**
- Modify: `app/src/modules/Build/panels/DefectDetail.tsx`

- [ ] **Step 1: Overwrite `DefectDetail.tsx`**

```typescript
import { useEffect, useState } from 'react';
import {
  type BuildDefect, type DefectStatus,
  DEFECT_CATEGORY_META, DEFECT_STATUS_META, SEVERITY_META,
  useBuildAttachments, attachmentSignedUrl, resolveDefect,
} from '../../../lib/build';
import { supabase } from '../../../lib/supabase';
import styles from '../Build.module.css';

type Props = { defect: BuildDefect; onClose: () => void; };

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm';
const MAX_FILE_SIZE = 26_214_400; // 25 MB

export function DefectDetail({ defect, onClose }: Props) {
  const { attachments } = useBuildAttachments(defect.id);
  const [resolveNote, setResolveNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cm = DEFECT_CATEGORY_META[defect.category];
  const sm = DEFECT_STATUS_META[defect.status];
  const sev = SEVERITY_META[defect.severity];

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null);
    try {
      for (const f of Array.from(files)) {
        if (f.size > MAX_FILE_SIZE) { setError(`${f.name} exceeds 25MB`); continue; }
        const path = `${defect.id}/${crypto.randomUUID()}-${f.name}`;
        const { error: upErr } = await supabase.storage
          .from('build-attachments')
          .upload(path, f, { contentType: f.type, upsert: false });
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
        const { error: attErr } = await supabase
          .from('build_attachments')
          .insert({
            defect_id: defect.id,
            file_path: path,
            file_name: f.name,
            mime_type: f.type,
            size_bytes: f.size,
          });
        if (attErr) throw new Error(`Attachment record failed: ${attErr.message}`);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitResolve() {
    if (!resolveNote.trim()) { setError('Resolution note required'); return; }
    setBusy(true); setError(null);
    try {
      await resolveDefect(defect.id, resolveNote);
      setResolveNote('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.detailOverlay} style={{ width: 380, right: 480, zIndex: 90 }}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{defect.subject}</h3>
          <div className={styles.detailSub}>
            <span className={styles.pill} style={{ background: cm.bg, color: cm.color }}>{cm.label}</span>{' '}
            <span className={styles.pill} style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>{' '}
            <span className={styles.pill} style={{ background: sev.color, color: '#fff' }}>{sev.label}</span>
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>

        {defect.description && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Description</div>
            <div style={{ fontSize: 12, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>
              {defect.description}
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Photos / Videos ({attachments.length})</div>
          {attachments.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No attachments.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {attachments.map(a => <AttachmentThumb key={a.id} att={a} />)}
            </div>
          )}
          <div className={styles.actionsRow}>
            <input type="file" multiple accept={ACCEPT_MIME}
              onChange={e => void uploadFiles(e.target.files)}
              disabled={busy} />
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Audit</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Found by</span>
            <span className={styles.detailFieldValue}>{defect.found_by_name ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Found at</span>
            <span className={styles.detailFieldValue}>{new Date(defect.found_at).toLocaleString()}</span>
            {defect.resolved_at && (<>
              <span className={styles.detailFieldLabel}>Resolved by</span>
              <span className={styles.detailFieldValue}>{defect.resolved_by_name ?? '—'}</span>
              <span className={styles.detailFieldLabel}>Resolved at</span>
              <span className={styles.detailFieldValue}>{new Date(defect.resolved_at).toLocaleString()}</span>
              <span className={styles.detailFieldLabel}>Note</span>
              <span className={styles.detailFieldValue}>{defect.resolution_note ?? '—'}</span>
            </>)}
            {defect.source_notion_url && (<>
              <span className={styles.detailFieldLabel}>Source</span>
              <a className={styles.detailFieldValue}
                href={defect.source_notion_url} target="_blank" rel="noreferrer">
                Notion ↗
              </a>
            </>)}
          </div>
        </div>

        {(defect.status === 'open' || defect.status === 'in_rework') && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Resolve</div>
            <textarea className={styles.textarea}
              placeholder="Resolution note (required)"
              value={resolveNote}
              onChange={e => setResolveNote(e.target.value)} />
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} disabled={busy} onClick={submitResolve}>
                Mark resolved
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}

function AttachmentThumb({ att }: { att: { id: string; file_path: string; file_name: string; mime_type: string } }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);
  if (!url) return <div style={{ width: 80, height: 80, background: 'var(--color-surface)' }} />;
  if (att.mime_type.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer"
        style={{ width: 80, height: 80, overflow: 'hidden', border: '1px solid var(--color-border)', borderRadius: 4 }}>
        <img src={url} alt={att.file_name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px',
        border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11, textDecoration: 'none' }}>
      📎 {att.file_name}
    </a>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 3: Manual verify**

Open `/build`. Click a unit → click a defect → DefectDetail opens nested next to UnitDetail. Upload a photo → thumbnail appears. Enter resolution note → click "Mark resolved" → trigger T4 fires → if unit has no other open defects, unit returns to 'ca-test'.

- [ ] **Step 4: Commit**

```powershell
git add app/src/modules/Build/panels/DefectDetail.tsx
git commit -m @'
feat(build): Defect detail panel with photo upload + resolve action

Nested slide-over next to UnitDetail. Upload images/videos to
build-attachments bucket (25MB cap, image+video MIME). Photo thumbnails
open full-size in new tab via signed URL. Resolve button with required
note triggers T4 to bump unit back to ca-test if all defects resolved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 10: NewPOModal + IQC serial claim

**Files:**
- Create: `app/src/modules/Build/NewPOModal.tsx`
- Modify: `app/src/modules/Build/index.tsx` (add the "+ New PO" button + serial-claim flow)

- [ ] **Step 1: Write `NewPOModal.tsx`**

```typescript
import { useState } from 'react';
import { createPO } from '../../lib/build';
import styles from './Build.module.css';

type Props = { onClose: () => void; onCreated?: () => void; };

export function NewPOModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    po_number: '',
    batch: 'P100',
    qty_ordered: 100,
    unit_cost_usd: '',
    manufacturer: 'Benliang',
    ship_target_date: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.po_number.trim()) { setError('PO number required'); return; }
    setBusy(true); setError(null);
    try {
      await createPO({
        po_number: form.po_number,
        batch: form.batch,
        qty_ordered: form.qty_ordered,
        unit_cost_usd: form.unit_cost_usd ? parseFloat(form.unit_cost_usd) : undefined,
        manufacturer: form.manufacturer,
        ship_target_date: form.ship_target_date || undefined,
      });
      onCreated?.();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 'var(--radius-md)',
          padding: 20, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>New Factory PO</h3>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>PO Number</span>
            <input className={styles.input} required value={form.po_number}
              onChange={e => setForm(s => ({ ...s, po_number: e.target.value }))}
              placeholder="BL-P100-2026-05-001" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Batch</span>
            <select className={styles.select} value={form.batch}
              onChange={e => setForm(s => ({ ...s, batch: e.target.value }))}>
              <option value="P50N">P50N</option>
              <option value="P100">P100</option>
              <option value="P100X">P100X</option>
              <option value="P200">P200</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Quantity</span>
            <input className={styles.input} type="number" min={1} value={form.qty_ordered}
              onChange={e => setForm(s => ({ ...s, qty_ordered: parseInt(e.target.value, 10) }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Unit cost (USD, optional)</span>
            <input className={styles.input} type="number" step="0.01" value={form.unit_cost_usd}
              onChange={e => setForm(s => ({ ...s, unit_cost_usd: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Manufacturer</span>
            <input className={styles.input} value={form.manufacturer}
              onChange={e => setForm(s => ({ ...s, manufacturer: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Target ship date (optional)</span>
            <input className={styles.input} type="date" value={form.ship_target_date}
              onChange={e => setForm(s => ({ ...s, ship_target_date: e.target.value }))} />
          </label>
          {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
          <div className={styles.actionsRow}>
            <button type="submit" className={styles.btnPrimary} disabled={busy}>Create PO</button>
            <button type="button" className={styles.btnSecondary} disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add "+ New PO" button + serial-claim modal to `Build/index.tsx`**

Edit `app/src/modules/Build/index.tsx`. Add imports:

```typescript
import { useState } from 'react';
import { NewPOModal } from './NewPOModal';
import { assignSerial } from '../../lib/build';
```

Inside the component (add useState):

```typescript
const [showNewPO, setShowNewPO] = useState(false);
const [showClaimSerial, setShowClaimSerial] = useState<{ batch: string } | null>(null);
const [claimSerial, setClaimSerial] = useState('');
const [claimBusy, setClaimBusy] = useState(false);
const [claimError, setClaimError] = useState<string | null>(null);

async function submitClaim() {
  if (!showClaimSerial) return;
  const s = claimSerial.trim();
  if (!/^LL01-\d{11}$/.test(s)) { setClaimError('Format: LL01-NNNNNNNNNNN'); return; }
  setClaimBusy(true); setClaimError(null);
  try {
    await assignSerial({ serial: s, batch: showClaimSerial.batch });
    setShowClaimSerial(null); setClaimSerial('');
  } catch (e) { setClaimError((e as Error).message); }
  finally { setClaimBusy(false); }
}
```

In the filterRow JSX, add a "+ New PO" button at the end:

```tsx
<button className={styles.btnPrimary} onClick={() => setShowNewPO(true)}>+ New PO</button>
```

After the closing `</div>` for the layout, add the modals:

```tsx
{showNewPO && <NewPOModal onClose={() => setShowNewPO(false)} />}
{showClaimSerial && (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
       onClick={() => setShowClaimSerial(null)}>
    <div onClick={e => e.stopPropagation()}
      style={{ background: '#fff', borderRadius: 'var(--radius-md)', padding: 20, width: 380 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
        Claim a serial for {showClaimSerial.batch}
      </h3>
      <input className={styles.input} placeholder="LL01-00000000XYZ"
        value={claimSerial}
        onChange={e => setClaimSerial(e.target.value.toUpperCase())} />
      {claimError && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{claimError}</div>}
      <div className={styles.actionsRow}>
        <button className={styles.btnPrimary} disabled={claimBusy} onClick={submitClaim}>Create unit</button>
        <button className={styles.btnSecondary} disabled={claimBusy} onClick={() => setShowClaimSerial(null)}>Cancel</button>
      </div>
    </div>
  </div>
)}
```

Pass `onClaimSerial={(batch) => setShowClaimSerial({ batch })}` to PipelineBoard (and add the prop type) — used to surface the claim flow from a button in the IQC column. **Minimal version for v1:** add the button at module-level (instead of in the IQC column) by adding a sibling button next to "+ New PO":

```tsx
<button className={styles.btnSecondary} onClick={() => setShowClaimSerial({ batch: 'P100' })}>
  + Claim serial
</button>
```

(Future polish: contextual button per column.)

- [ ] **Step 3: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 4: Manual verify**

`npm run dev`. Open `/build`. Click "+ New PO" → modal opens → fill in `BL-TEST-001`, P100, qty 5 → Create. Modal closes; new card appears in PO column. Click "+ Claim serial" → enter `LL01-00000000999` → Create → unit appears in IQC column.

Roll back test data:
```sql
delete from public.factory_orders where po_number='BL-TEST-001';
delete from public.units where serial='LL01-00000000999';
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/modules/Build/NewPOModal.tsx app/src/modules/Build/index.tsx
git commit -m @'
feat(build): New PO modal + Claim Serial modal

+ New PO button opens a modal to create a factory_orders row (PO number,
batch, qty, cost, manufacturer, target ship date). + Claim Serial button
creates a unit row at status=ca-test for an arrived batch — Aaron uses
this at the IQC station as he physically scans each unit. Serial format
validation: LL01-NNNNNNNNNNN.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 11: TableView (alternate flat view)

**Files:**
- Modify: `app/src/modules/Build/TableView.tsx`

- [ ] **Step 1: Overwrite `TableView.tsx`**

```typescript
import { useMemo, useState } from 'react';
import {
  type FactoryOrder, type FreightShipment, type BuildDefect, type BurnInTest,
  PO_STATUS_META, FREIGHT_STATUS_META,
} from '../../lib/build';
import type { Unit } from '../../lib/stock';
import { BatchDetail } from './panels/BatchDetail';
import { UnitDetail } from './panels/UnitDetail';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function TableView({ orders, shipments, defects, tests, units, batchFilter, search }: Props) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedUnitSerial, setSelectedUnitSerial] = useState<string | null>(null);

  const matchSearch = (text: string) => !search || text.toLowerCase().includes(search.toLowerCase());

  const filteredOrders = orders.filter(o =>
    (batchFilter === 'all' || o.batch === batchFilter) &&
    matchSearch(`${o.po_number} ${o.batch}`)
  );
  const filteredUnits = units.filter(u =>
    ['inbound','ca-test','rework','ready'].includes(u.status) &&
    (batchFilter === 'all' || u.batch === batchFilter) &&
    matchSearch(`${u.serial} ${u.batch}`)
  );

  const freightByPo = useMemo(() => {
    const m = new Map<string, FreightShipment>();
    for (const s of shipments) m.set(s.po_id, s);
    return m;
  }, [shipments]);
  const defectsBySerial = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of defects) {
      if (d.status === 'open' || d.status === 'in_rework') {
        m.set(d.unit_serial, (m.get(d.unit_serial) ?? 0) + 1);
      }
    }
    return m;
  }, [defects]);
  const burnInBySerial = useMemo(() => {
    const m = new Map<string, BurnInTest>();
    for (const t of tests) if (!t.ended_at) m.set(t.unit_serial, t);
    return m;
  }, [tests]);

  const selectedOrder = selectedOrderId ? orders.find(o => o.id === selectedOrderId) ?? null : null;
  const selectedUnit = selectedUnitSerial ? units.find(u => u.serial === selectedUnitSerial) ?? null : null;

  return (
    <>
      <div className={styles.tableWrap}>
        <h4 style={{ margin: '4px 0 8px', fontSize: 13 }}>Factory POs ({filteredOrders.length})</h4>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>PO #</th><th>Batch</th><th>Qty</th><th>Status</th>
              <th>Freight</th><th>ETA</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map(o => {
              const f = freightByPo.get(o.id);
              const poMeta = PO_STATUS_META[o.status];
              const fMeta = f ? FREIGHT_STATUS_META[f.status] : null;
              return (
                <tr key={o.id} className={styles.row} onClick={() => setSelectedOrderId(o.id)}>
                  <td className={styles.cardMono}>{o.po_number}</td>
                  <td>{o.batch}</td>
                  <td>{o.qty_ordered}</td>
                  <td><span className={styles.pill} style={{ background: poMeta.bg, color: poMeta.color }}>{poMeta.label}</span></td>
                  <td>{fMeta && <span className={styles.pill} style={{ background: fMeta.bg, color: fMeta.color }}>{fMeta.label}</span>}</td>
                  <td>{f?.eta_canada ? new Date(f.eta_canada).toLocaleDateString() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h4 style={{ margin: '20px 0 8px', fontSize: 13 }}>Units in Build ({filteredUnits.length})</h4>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Serial</th><th>Batch</th><th>Status</th>
              <th>Open defects</th><th>Burn-in</th>
            </tr>
          </thead>
          <tbody>
            {filteredUnits.map(u => {
              const dCount = defectsBySerial.get(u.serial) ?? 0;
              const bt = burnInBySerial.get(u.serial);
              const elapsed = bt ? Math.round((Date.now() - new Date(bt.started_at).getTime()) / 3_600_000) : null;
              return (
                <tr key={u.serial} className={styles.row} onClick={() => setSelectedUnitSerial(u.serial)}>
                  <td className={styles.cardMono}>{u.serial}</td>
                  <td>{u.batch}</td>
                  <td>{u.status}</td>
                  <td>{dCount > 0 ? dCount : '—'}</td>
                  <td>{bt ? `${elapsed}h / ${bt.duration_target_hours}h` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedOrder && (
        <BatchDetail
          order={selectedOrder}
          freight={freightByPo.get(selectedOrder.id) ?? null}
          unitsLanded={units.filter(u => u.batch === selectedOrder.batch).length}
          onClose={() => setSelectedOrderId(null)} />
      )}
      {selectedUnit && (
        <UnitDetail
          unit={selectedUnit}
          defects={defects.filter(d => d.unit_serial === selectedUnit.serial)}
          tests={tests.filter(t => t.unit_serial === selectedUnit.serial)}
          onClose={() => setSelectedUnitSerial(null)} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 3: Manual verify**

Open `/build` → click Table view. Two tables render. Click any row → same detail panels as Board view open.

- [ ] **Step 4: Commit**

```powershell
git add app/src/modules/Build/TableView.tsx
git commit -m @'
feat(build): Table view as alternate flat view

Two stacked tables (Factory POs / Units in Build) with the same filter
+ search as the Pipeline Board. Row click opens the same Batch/Unit
detail panels. Useful for keyboard-driven scanning or exporting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 12: Replace flagRework writer → build_defects

**Files:**
- Modify: `app/src/lib/fulfillment.ts:264` (the `flagRework` function)

- [ ] **Step 1: Locate and update `flagRework`**

The existing function writes to `unit_reworks` and updates `shelf_slots` + `fulfillment_queue`. Read the existing implementation first if needed. The change is: replace the `unit_reworks` INSERT with a `build_defects` INSERT.

Find:
```typescript
  // Insert rework row
  const { error: rwErr } = await supabase.from('unit_reworks').insert({
    serial,
    issue,
    flagged_by: userId,
    flagged_by_name: flaggedByName,
  });
  if (rwErr) throw rwErr;
```

Replace with:
```typescript
  // Insert into build_defects (replaces deprecated unit_reworks).
  // Trigger T3 will set units.status='rework'. category='assembly' is a
  // reasonable default for QC-step flags (Aaron flags anything mechanical or
  // visual that fails the test step); severity='high' because the unit was
  // about to ship.
  const { error: rwErr } = await supabase.from('build_defects').insert({
    unit_serial: serial,
    category: 'assembly',
    subject: `QC flag: ${issue.slice(0, 80)}`,
    description: issue,
    severity: 'high',
    status: 'in_rework',
    found_by: userId,
    found_by_name: flaggedByName,
  });
  if (rwErr) throw rwErr;
```

Also remove the manual `shelf_slots` flip to 'rework' if the trigger T3 handles it. Actually trigger T3 updates `units.status='rework'` but does NOT touch shelf_slots. The existing `flagRework` also explicitly updates the shelf slot status. Keep that part. Final `flagRework`:

Show the full new body for clarity:

```typescript
export async function flagRework(
  queueId: string,
  serial: string,
  issue: string,
  flaggedByName: string,
): Promise<void> {
  const userId = await currentUserId();
  // Insert into build_defects (replaces deprecated unit_reworks). Trigger T3
  // will set units.status='rework' automatically.
  const { error: rwErr } = await supabase.from('build_defects').insert({
    unit_serial: serial,
    category: 'assembly',
    subject: `QC flag: ${issue.slice(0, 80)}`,
    description: issue,
    severity: 'high',
    status: 'in_rework',
    found_by: userId,
    found_by_name: flaggedByName,
  });
  if (rwErr) throw rwErr;
  // Flip shelf slot to rework
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'rework', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Drop queue row to step 1 + clear assigned serial
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ step: 1, assigned_serial: null })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction('fq_test_flagged', queueId, `${serial}: ${issue}`);

  // ALSO create a service_ticket so Service module's Repair tab picks this up
  // (existing behavior, idempotent on fulfillment_queue_id).
  try {
    const { data: existing } = await supabase
      .from('service_tickets')
      .select('id')
      .eq('fulfillment_queue_id', queueId)
      .eq('source', 'fulfillment_flag')
      .maybeSingle();
    if (!existing) {
      const { error: tErr } = await supabase
        .from('service_tickets')
        .insert({
          category:             'repair',
          source:               'fulfillment_flag',
          status:               'new',
          priority:             'high',
          unit_serial:          serial,
          subject:              `QC flag: ${issue}`,
          description:          `Flagged at fulfillment QC by ${flaggedByName}.`,
          fulfillment_queue_id: queueId,
          owner_email:          'junaid@virgohome.io',
        });
      if (tErr) console.warn('Service ticket insert failed (non-fatal):', tErr.message);
    }
  } catch (e) {
    console.warn('Service ticket insert threw (non-fatal):', (e as Error).message);
  }
}
```

(The service_ticket insert at the bottom is the existing Task 14 work from the Service module plan — keep it.)

- [ ] **Step 2: Build**

```powershell
cd app
npm run build
cd ..
```

- [ ] **Step 3: Manual verify**

In Fulfillment module, find a queue row at the Test step. Flag it as failed with a test message. Switch to Build module → Rework column → new card appears with the serial and the QC flag subject. Click → DefectDetail shows category='assembly', severity='high', status='in_rework'.

Roll back: undo the QC flag in Fulfillment, then delete the new defect row by SQL.

- [ ] **Step 4: Commit**

```powershell
git add app/src/lib/fulfillment.ts
git commit -m @'
refactor(fulfillment): flagRework now writes build_defects instead of unit_reworks

Per Build module design, unit_reworks is deprecated. flagRework continues
to flip shelf_slots and reset fulfillment_queue, but now writes the rework
record into build_defects with category=assembly, severity=high,
status=in_rework. Trigger T3 promotes the unit to status=rework. The
existing service_ticket insert is preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 13: One-shot Notion historical import script

**Files:**
- Create: `scripts/import-notion-iqc-log.mjs`

This is NOT a migration; it's a one-shot script run manually after launch.

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// One-shot import: pull the Master Issue Log from Notion and insert each row
// into public.build_defects with category='legacy_iqc_notion'. Run once after
// Build module launch.
//
// Prereq env vars:
//   SUPABASE_URL                 (e.g. https://txeftbbzeflequvrmjjr.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY    (from Supabase Studio → Settings → API)
//   NOTION_TOKEN                 (Notion internal integration token)
//   NOTION_DATABASE_ID           (= 27fffbba4c38802e9e37d20bd4d201f2)
//
// Run: node scripts/import-notion-iqc-log.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB    = process.env.NOTION_DATABASE_ID ?? '27fffbba4c38802e9e37d20bd4d201f2';

if (!SUPABASE_URL || !SERVICE_KEY || !NOTION_TOKEN) {
  console.error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NOTION_TOKEN');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

// Map Notion "Type of Issue" → our DefectCategory
const CATEGORY_MAP = {
  Electrical:  'electrical',
  Mechanical:  'mechanical',
  Software:    'firmware',
  'Aesthetic Defect': 'aesthetic',
  'Unknown Field Issue': 'other',
};
// Map Notion "Impact" → our DefectSeverity
const SEVERITY_MAP = {
  High:   'high',
  Medium: 'medium',
  Low:    'low',
};

async function notionQuery(database_id, start_cursor) {
  const body = { page_size: 100 };
  if (start_cursor) body.start_cursor = start_cursor;
  const res = await fetch(`https://api.notion.com/v1/databases/${database_id}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function textFromRich(rich) {
  if (!Array.isArray(rich)) return '';
  return rich.map(r => r.plain_text ?? '').join('');
}

function mapPage(page) {
  const props = page.properties ?? {};
  const issue = textFromRich(props.Issue?.title);
  const description = textFromRich(props['Description of Issue']?.rich_text);
  const typeOf = (props['Type of Issue']?.multi_select ?? []).map(x => x.name);
  const impact = props.Impact?.select?.name;
  const machines = textFromRich(props['Machines Affected (Serial Number)']?.rich_text);

  // Pick the first known category from the multi-select; default 'other'
  const category = typeOf.map(t => CATEGORY_MAP[t]).find(Boolean) ?? 'other';
  const severity = SEVERITY_MAP[impact] ?? 'medium';

  // Try to extract a unit serial from machines field if it looks like LL01-...
  const serialMatch = machines.match(/LL01-\d{11}/);
  return {
    unit_serial: serialMatch?.[0] ?? null,
    category: 'legacy_iqc_notion',
    subject: issue || '(no title)',
    description: [
      description || '',
      machines ? `\n\nMachines affected: ${machines}` : '',
      typeOf.length > 0 ? `\nOriginal type: ${typeOf.join(', ')}` : '',
    ].join('').trim() || null,
    severity,
    status: 'resolved',
    found_by_name: 'Notion import',
    source_notion_url: page.url,
    found_at: page.created_time,
    resolved_at: page.last_edited_time,
  };
}

async function main() {
  let cursor = undefined;
  const allRows = [];
  do {
    const page = await notionQuery(NOTION_DB, cursor);
    for (const row of page.results) {
      const mapped = mapPage(row);
      // Skip rows where the serial doesn't exist (would FK-fail).
      if (!mapped.unit_serial) {
        console.warn(`Skip ${row.id}: no LL01 serial in "Machines Affected"`);
        continue;
      }
      const { data: u } = await admin.from('units')
        .select('serial').eq('serial', mapped.unit_serial).maybeSingle();
      if (!u) {
        console.warn(`Skip ${row.id}: unit ${mapped.unit_serial} not in DB`);
        continue;
      }
      allRows.push(mapped);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  console.log(`Importing ${allRows.length} rows...`);
  const { data, error } = await admin.from('build_defects').insert(allRows).select('id');
  if (error) {
    console.error('Insert failed:', error.message);
    process.exit(1);
  }
  console.log(`Imported ${data.length} rows.`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Skip running for now**

Don't run the script yet — it requires `NOTION_TOKEN` in the shell environment which the user may not have set. The script is committed to the repo; the user runs it later when they're ready.

- [ ] **Step 3: Commit**

```powershell
git add scripts/import-notion-iqc-log.mjs
git commit -m @'
chore(build): one-shot Notion Master Issue Log import script

Run once after Build launch. Pulls all rows from the Notion Master Issue
Log database, maps Type of Issue → DefectCategory and Impact → DefectSeverity,
inserts into build_defects with category=legacy_iqc_notion and links back
to the source Notion page. Skips rows without an LL01-serial.

Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NOTION_TOKEN.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Verification (post-implementation)

After all tasks complete, run a final smoke test:

1. `/build` loads with KPI strip filled in from DB
2. "+ New PO" creates a row; appears in PO/Production column
3. Add freight to that PO; advance freight to 'arrived'
4. Click "+ Claim serial" with the PO's batch; serial appears in IQC column
5. Click unit → log a defect (mechanical/high/"test") → unit moves to Rework column
6. Click defect → upload a photo → resolution note → mark resolved → unit returns to IQC
7. From IQC card (no open defects), Start 24h burn-in → unit appears in Burn-in column
8. End burn-in PASS → unit appears in Ready column
9. Release to Fulfillment → unit status stays 'ready' (existing Fulfillment flow picks it up when an order is approved)
10. From Fulfillment module, flag a test → defect appears in Build's Rework column (Task 12 wiring)
11. Switch to Table view → both tables render and link to same detail panels

Push origin/main → GitHub Pages deploys → manually verify on `lila.vip`.

---

## Deferred items (out of scope)

- Push fulfillment status back to Benliang's system (BL is WeChat-based)
- Cost roll-up dashboard (PO × landed units = unit landed cost)
- Per-unit BOM tracking
- ISTA 3A drop-test results
- Automated freight tracking via carrier API
- ML-based defect category auto-classification
