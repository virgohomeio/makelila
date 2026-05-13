# Service Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Service module that consolidates onboarding (Calendly), support (form + HubSpot sync), repair (from Fulfillment QC flag), and computed warranty tracking — replacing scattered tracking in HubSpot/Calendly/WeChat/spreadsheets.

**Architecture:** Two tables (`customer_lifecycle` per-shipped-unit + `service_tickets` unified by category enum) plus `service_ticket_attachments` backed by a private Supabase Storage bucket. Four intake paths (Calendly poll, public form, HubSpot poll, Fulfillment QC flag) write into the same tickets table. Status transitions trigger template auto-fires via existing `send-template-email` edge function. UI is 3 tabs (Onboarding/Support/Repair) inside a new `/service` route; warranty is computed and surfaced as a pill on every ticket.

**Tech Stack:** React 19 + TypeScript + Vite (existing app), Supabase Postgres + RLS + realtime + Storage, Supabase Edge Functions (Deno 2), pg_cron + pg_net for periodic syncs and template auto-fires.

**Source spec:** [docs/superpowers/specs/2026-04-21-service-module-design.md](../specs/2026-04-21-service-module-design.md)

**Verification model:** This codebase has no automated test suite. Verification uses TypeScript build (`npm run build` inside `app/`), Supabase migrations (`supabase db push` against remote project ref `txeftbbzeflequvrmjjr`), and manual browser testing. Each task ends with a deploy/build + manual-verify + commit.

**Environment assumptions:**
- `SUPABASE_ACCESS_TOKEN` exported in shell for migration push
- Supabase project ref `txeftbbzeflequvrmjjr` linked (`supabase link --project-ref txeftbbzeflequvrmjjr`)
- `app/node_modules/.bin/supabase` is the CLI entry point (alias `pnpx supabase` works too)
- HubSpot private app token in Supabase secrets as `HUBSPOT_ACCESS_TOKEN` (already set for `sync-hubspot-customers`)
- Resend key in Supabase secrets as `RESEND_API_KEY` (already set)
- `EMAIL_TEST_RECIPIENT=huayi@virgohome.io` in Supabase secrets (already set)

---

## File Structure

### New SQL migrations (4 files, in numeric order)

- `supabase/migrations/20260512100000_service_module_schema.sql` — customer_lifecycle, service_tickets, service_ticket_attachments tables + ticket number trigger + lifecycle auto-create trigger + RLS + realtime
- `supabase/migrations/20260512110000_service_storage_bucket.sql` — `ticket-attachments` bucket + policies
- `supabase/migrations/20260512120000_service_templates.sql` — 3 new email_templates rows (onboarding_calendly_confirmation, onboarding_followup_check_in, warranty_expired_quote)
- `supabase/migrations/20260512130000_service_pg_cron.sql` — Calendly hourly poll, HubSpot hourly poll, daily auto-close, template auto-fire trigger using pg_net

### New edge functions (2)

- `supabase/functions/sync-calendly-events/index.ts` — hourly Calendly poll → upsert onboarding tickets
- `supabase/functions/sync-hubspot-tickets/index.ts` — hourly HubSpot tickets poll → upsert support tickets

### Modified `supabase/config.toml`

- Add `[functions.sync-calendly-events] verify_jwt = false`
- Add `[functions.sync-hubspot-tickets] verify_jwt = false`

### New app library

- `app/src/lib/service.ts` — types (`ServiceTicket`, `CustomerLifecycle`, `TicketAttachment`, etc.), realtime hooks (`useServiceTickets`, `useCustomerLifecycle`, `useTicketAttachments`), mutations (`updateTicketStatus`, `assignOwner`, `addInternalNote`, `markOnboardingComplete`, etc.), category/status/priority constants + palette

### New Service module

- `app/src/modules/Service/index.tsx` — module shell + 3 tab routing
- `app/src/modules/Service/Service.module.css` — module styles (layout, tabs, KPIs, tables, detail panel, warranty pill)
- `app/src/modules/Service/AttachmentStrip.tsx` — image/video rendering + download links
- `app/src/modules/Service/TicketDetailPanel.tsx` — shared detail panel for Support + Repair tabs
- `app/src/modules/Service/OnboardingTab.tsx` — Calendly-sourced onboarding tickets
- `app/src/modules/Service/SupportTab.tsx` — Form + HubSpot support tickets
- `app/src/modules/Service/RepairTab.tsx` — Fulfillment-QC-flagged repair tickets

### Public form

- `app/src/modules/Forms/ServiceRequestForm.tsx` — `/service-request` public form with multimedia upload

### Modified files

- `app/src/App.tsx` — add `/service` (protected) and `/service-request` (public) routes
- `app/src/components/GlobalNav.tsx` — add Service module entry
- `app/src/lib/fulfillment.ts` — extend `flagRework` to also INSERT into `service_tickets`

---

## Task 1: Schema migration — tables + triggers

**Files:**
- Create: `supabase/migrations/20260512100000_service_module_schema.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Service module schema: customer lifecycle + unified service tickets +
-- attachments. Three intake sources (Calendly poll, public form, HubSpot
-- sync) + one internal source (Fulfillment QC flag) write into
-- service_tickets, distinguished by category enum.
--
-- customer_lifecycle is one row per shipped unit (NOT per customer): a
-- customer with two units gets two lifecycle rows. Clean for per-unit
-- warranty + onboarding tracking. Auto-created by trigger when
-- units.status transitions to 'shipped'.

-- ============================================================ customer_lifecycle
-- units.serial is the natural key (text, format LL01-NNNNNNNNNNN). Lifecycle
-- joins to units via serial; one row per shipped unit.
create table if not exists public.customer_lifecycle (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  unit_serial text not null references public.units(serial) on delete cascade unique,
  shipped_at timestamptz not null,
  onboarding_status text not null default 'not_scheduled'
    check (onboarding_status in ('not_scheduled','scheduled','completed','no_show','skipped')),
  onboarding_completed_at timestamptz,
  warranty_months int not null default 12,
  warranty_expires_at timestamptz generated always as
    (shipped_at + (warranty_months || ' months')::interval) stored,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lifecycle_customer on public.customer_lifecycle (customer_id);
create index if not exists idx_lifecycle_warranty on public.customer_lifecycle (warranty_expires_at);

alter table public.customer_lifecycle enable row level security;
create policy "lifecycle_select" on public.customer_lifecycle for select to authenticated using (true);
create policy "lifecycle_insert" on public.customer_lifecycle for insert to authenticated with check (true);
create policy "lifecycle_update" on public.customer_lifecycle for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.customer_lifecycle;

create or replace function public.touch_lifecycle_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists lifecycle_touch on public.customer_lifecycle;
create trigger lifecycle_touch before update on public.customer_lifecycle
  for each row execute function public.touch_lifecycle_updated_at();

-- ============================================================ service_tickets
create table if not exists public.service_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text unique,                 -- filled by trigger: ST-YYYY-NNNN
  category text not null check (category in ('onboarding','support','repair')),
  source text not null check (source in ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual')),
  status text not null default 'new'
    check (status in ('new','triaging','in_progress','waiting_customer','resolved','closed','escalated')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),

  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  customer_email text,
  customer_phone text,

  -- units.serial is the natural key; FK is loose (on delete set null) so
  -- units can be archived without losing the ticket history.
  unit_serial text references public.units(serial) on delete set null,
  order_ref text,

  subject text not null,
  description text,
  internal_notes text,

  defect_category text,                      -- repair: Door/Auger/Heater/Sensor/Wiring/Other
  parts_needed text,
  calendly_event_uri text unique,            -- onboarding dedupe
  calendly_event_start timestamptz,
  calendly_host_email text,
  hubspot_ticket_id text unique,             -- hubspot dedupe
  fulfillment_queue_id uuid references public.fulfillment_queue(id) on delete set null,

  owner_email text,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tickets_cat_status on public.service_tickets (category, status);
create index if not exists idx_tickets_customer on public.service_tickets (customer_id);
create index if not exists idx_tickets_unit on public.service_tickets (unit_serial);
create index if not exists idx_tickets_created on public.service_tickets (created_at desc);

alter table public.service_tickets enable row level security;
create policy "tickets_select" on public.service_tickets for select to authenticated using (true);
create policy "tickets_insert_auth" on public.service_tickets for insert to authenticated with check (true);
create policy "tickets_insert_anon" on public.service_tickets for insert to anon
  with check (source = 'customer_form');
create policy "tickets_update" on public.service_tickets for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.service_tickets;

create or replace function public.touch_tickets_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tickets_touch on public.service_tickets;
create trigger tickets_touch before update on public.service_tickets
  for each row execute function public.touch_tickets_updated_at();

-- Ticket number generator: ST-YYYY-NNNN, per-year sequence using an
-- advisory lock to serialize the count. Cheaper than maintaining a
-- per-year sequence object.
create or replace function public.assign_ticket_number() returns trigger language plpgsql as $$
declare
  yr int := extract(year from now())::int;
  n int;
begin
  if new.ticket_number is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('service_ticket_number_' || yr));
  select coalesce(max(substring(ticket_number from '\d+$')::int), 0) + 1
    into n
    from public.service_tickets
    where ticket_number like 'ST-' || yr || '-%';
  new.ticket_number := 'ST-' || yr || '-' || lpad(n::text, 4, '0');
  return new;
end $$;
drop trigger if exists tickets_assign_number on public.service_tickets;
create trigger tickets_assign_number before insert on public.service_tickets
  for each row execute function public.assign_ticket_number();

-- Auto-stamp resolved_at / closed_at when status transitions
create or replace function public.tickets_stamp_terminal() returns trigger language plpgsql as $$
begin
  if new.status = 'resolved' and (old.status is distinct from 'resolved') then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if new.status = 'closed' and (old.status is distinct from 'closed') then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end $$;
drop trigger if exists tickets_stamp on public.service_tickets;
create trigger tickets_stamp before update on public.service_tickets
  for each row execute function public.tickets_stamp_terminal();

-- ============================================================ attachments
create table if not exists public.service_ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.service_tickets(id) on delete cascade,
  file_path text not null,                   -- path within ticket-attachments bucket
  file_name text not null,                   -- original filename
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id) on delete set null
);
create index if not exists idx_attachments_ticket on public.service_ticket_attachments (ticket_id);

alter table public.service_ticket_attachments enable row level security;
create policy "attachments_select" on public.service_ticket_attachments for select to authenticated using (true);
create policy "attachments_insert_auth" on public.service_ticket_attachments for insert to authenticated with check (true);
create policy "attachments_insert_anon" on public.service_ticket_attachments for insert to anon
  with check (
    exists (select 1 from public.service_tickets t
            where t.id = ticket_id and t.source = 'customer_form')
  );

alter publication supabase_realtime add table public.service_ticket_attachments;

-- ============================================================ lifecycle auto-create
-- When a unit transitions to status='shipped', create the lifecycle row.
-- shipped_at is taken from units.shipped_at if set, else now(). Customer
-- linkage is best-effort: units.customer_order_ref → orders.order_ref →
-- orders.customer_email → customers.email.
create or replace function public.create_lifecycle_row() returns trigger language plpgsql as $$
declare
  cust_id uuid;
  ship_ts timestamptz;
begin
  ship_ts := coalesce(new.shipped_at, now());
  if new.customer_order_ref is not null then
    select c.id into cust_id
      from public.orders o
      join public.customers c on lower(c.email) = lower(o.customer_email)
      where o.order_ref = new.customer_order_ref
      limit 1;
  end if;
  insert into public.customer_lifecycle (customer_id, unit_serial, shipped_at, warranty_months)
  values (cust_id, new.serial, ship_ts, 12)
  on conflict (unit_serial) do nothing;
  return new;
end $$;

drop trigger if exists units_create_lifecycle_on_ship on public.units;
create trigger units_create_lifecycle_on_ship
  after update of status on public.units
  for each row
  when (old.status is distinct from new.status and new.status = 'shipped')
  execute function public.create_lifecycle_row();

-- Back-fill lifecycle rows for already-shipped units
insert into public.customer_lifecycle (customer_id, unit_serial, shipped_at, warranty_months)
select
  (
    select c.id
      from public.orders o
      join public.customers c on lower(c.email) = lower(o.customer_email)
      where o.order_ref = u.customer_order_ref
      limit 1
  ),
  u.serial,
  coalesce(u.shipped_at, u.status_updated_at, now()),
  12
from public.units u
where u.status = 'shipped'
  and not exists (select 1 from public.customer_lifecycle cl where cl.unit_serial = u.serial);
```

- [ ] **Step 2: Apply migration**

Run from repo root (PowerShell):
```powershell
$env:SUPABASE_ACCESS_TOKEN = "<sbp_token>"
& app/node_modules/.bin/supabase db push --linked
```

Expected: migration applies cleanly. Look for `Finished supabase db push.` and no `ERROR:` lines. The back-fill on the last statement will report how many lifecycle rows were created.

- [ ] **Step 3: Verify in Supabase**

Run (in SQL editor or via `execute_sql` MCP):
```sql
select count(*) as lifecycle_rows from public.customer_lifecycle;
select column_name from information_schema.columns where table_name='service_tickets' order by ordinal_position;
select count(*) as shipped_units from public.units where status='shipped';
```

Expected: `lifecycle_rows` equals `shipped_units`. service_tickets columns include ticket_number, category, source, status, priority, hubspot_ticket_id, calendly_event_uri.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260512100000_service_module_schema.sql
git commit -m "feat(service): schema for customer_lifecycle + service_tickets + attachments`n`nThree tables with RLS, anonymous-form INSERT policies for customer-submitted`ntickets/attachments, ticket number trigger (ST-YYYY-NNNN), and auto-create`nlifecycle row on unit shipment with back-fill for existing shipped units.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Storage bucket migration

**Files:**
- Create: `supabase/migrations/20260512110000_service_storage_bucket.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ticket-attachments bucket for customer-submitted photos/videos and
-- ops-uploaded files. Private; access via signed URLs from the app.
-- Anon INSERT is allowed for customer-form uploads (validated by
-- attachment row INSERT policy which checks parent ticket source).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-attachments',
  'ticket-attachments',
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

-- Read: any authenticated user (ops team)
create policy "ticket_attachments_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'ticket-attachments');

-- Write: authenticated users (ops) anywhere in the bucket
create policy "ticket_attachments_write_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ticket-attachments');

-- Write: anon users only into a path matching their just-created ticket id.
-- The application uploads to {ticket_id}/{uuid}-{filename} after the ticket
-- has been inserted; the path prefix gates access by enforcing that the
-- first path segment is a valid uuid.
create policy "ticket_attachments_write_anon" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
```

- [ ] **Step 2: Apply migration**

```powershell
& app/node_modules/.bin/supabase db push --linked
```

Expected: bucket created, three policies applied.

- [ ] **Step 3: Verify bucket exists**

In Supabase dashboard → Storage, confirm `ticket-attachments` bucket exists, is **private**, and has the size + MIME limits set.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260512110000_service_storage_bucket.sql
git commit -m "feat(service): ticket-attachments storage bucket with anon upload policy`n`nPrivate bucket, 25MB cap, image+video MIME allow-list. Anon INSERT gated`non path prefix being a valid uuid (the just-created ticket id).`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Seed 3 new email templates

**Files:**
- Create: `supabase/migrations/20260512120000_service_templates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Three new email templates for the Service module, added to the existing
-- 18-template library. Variables follow the {{snake_case}} convention
-- rendered by send-template-email edge function and renderTemplate() in
-- app/src/lib/templates.ts.

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
  (
    'onboarding_calendly_confirmation',
    'Onboarding — Calendly confirmation',
    'support',
    'Sent automatically when a customer schedules an onboarding call. Confirms the booked time and provides the meeting link.',
    'Your LILA Pro onboarding call is confirmed',
    'Hi {{customer_first_name}},

Your LILA Pro onboarding call is booked for {{event_start_local}} ({{event_timezone}}).

Meeting link: {{event_url}}
Host: {{host_name}}

We''ll walk you through unboxing, first run, daily use, and answer any questions you have. Please have your unit (serial: {{unit_serial}}) plugged in and ready before the call.

If you need to reschedule, use the link above.

Talk soon,
The VCycene team',
    array['customer_first_name','event_start_local','event_timezone','event_url','host_name','unit_serial'],
    'email',
    true
  ),
  (
    'onboarding_followup_check_in',
    'Onboarding — Follow-up check-in',
    'support',
    'Sent after onboarding is marked complete. Asks how things are going and invites questions.',
    'How''s your LILA Pro running?',
    'Hi {{customer_first_name}},

It''s been a few days since your onboarding call — we wanted to check in.

How is your LILA Pro running? Any questions or quirks we can help with?

A few common things people ask about in week one:
  • First-cycle smell — normal as the heater seasons; clears in 2-3 cycles
  • Cycle time — runs 4-8 hours depending on load and moisture
  • What goes in — see our quick reference: https://lilacomposter.com/guides

Just reply to this email if anything''s off. We''re here.

Best,
The VCycene team',
    array['customer_first_name'],
    'email',
    true
  ),
  (
    'warranty_expired_quote',
    'Warranty — Out-of-warranty quote',
    'support',
    'Suggested send when a support/repair ticket arrives for a unit whose warranty has lapsed. Politely informs customer and offers a paid repair quote.',
    'About your LILA Pro service request',
    'Hi {{customer_first_name}},

Thank you for reaching out about your LILA Pro (serial: {{unit_serial}}).

We checked your records — this unit shipped on {{shipped_date}}, which puts it {{months_out_of_warranty}} months past our standard 12-month warranty.

We can still service it. A typical out-of-warranty repair runs $150-$400 depending on the issue (parts + labor + return shipping). If you''d like to proceed, reply to this email and we''ll send a firm quote within 2 business days after a quick diagnosis.

Best,
The VCycene team',
    array['customer_first_name','unit_serial','shipped_date','months_out_of_warranty'],
    'email',
    true
  )
on conflict (key) do nothing;
```

- [ ] **Step 2: Apply migration**

```powershell
& app/node_modules/.bin/supabase db push --linked
```

Expected: 3 rows inserted into email_templates.

- [ ] **Step 3: Verify in app**

Open Templates module (`/templates`) and confirm the 3 new templates appear in the sidebar under their categories.

- [ ] **Step 4: Commit**

```powershell
git add supabase/migrations/20260512120000_service_templates.sql
git commit -m "feat(service): seed 3 templates for onboarding + warranty flows`n`nonboarding_calendly_confirmation (auto on Calendly poll),`nonboarding_followup_check_in (suggested after onboarding resolved),`nwarranty_expired_quote (suggested when warranty lapsed on incoming ticket).`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: lib/service.ts — types, hooks, mutations

**Files:**
- Create: `app/src/lib/service.ts`

- [ ] **Step 1: Write the library**

```typescript
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

export type TicketCategory = 'onboarding' | 'support' | 'repair';
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag' | 'ops_manual';
export type TicketStatus =
  | 'new' | 'triaging' | 'in_progress' | 'waiting_customer'
  | 'resolved' | 'closed' | 'escalated';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type OnboardingStatus =
  | 'not_scheduled' | 'scheduled' | 'completed' | 'no_show' | 'skipped';

export type ServiceTicket = {
  id: string;
  ticket_number: string;
  category: TicketCategory;
  source: TicketSource;
  status: TicketStatus;
  priority: TicketPriority;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  unit_serial: string | null;
  order_ref: string | null;
  subject: string;
  description: string | null;
  internal_notes: string | null;
  defect_category: string | null;
  parts_needed: string | null;
  calendly_event_uri: string | null;
  calendly_event_start: string | null;
  calendly_host_email: string | null;
  hubspot_ticket_id: string | null;
  fulfillment_queue_id: string | null;
  owner_email: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerLifecycle = {
  id: string;
  customer_id: string | null;
  unit_serial: string;
  shipped_at: string;
  onboarding_status: OnboardingStatus;
  onboarding_completed_at: string | null;
  warranty_months: number;
  warranty_expires_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type TicketAttachment = {
  id: string;
  ticket_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

// ============================================================ Display metadata

export const CATEGORY_META: Record<TicketCategory, { label: string; color: string; bg: string }> = {
  onboarding: { label: 'Onboarding', color: '#276749', bg: '#f0fff4' },
  support:    { label: 'Support',    color: '#2b6cb0', bg: '#ebf8ff' },
  repair:     { label: 'Repair',     color: '#c05621', bg: '#fffaf0' },
};

export const STATUS_META: Record<TicketStatus, { label: string; color: string; bg: string }> = {
  new:              { label: 'New',              color: '#2b6cb0', bg: '#ebf8ff' },
  triaging:         { label: 'Triaging',         color: '#553c9a', bg: '#faf5ff' },
  in_progress:      { label: 'In progress',      color: '#c05621', bg: '#fffaf0' },
  waiting_customer: { label: 'Waiting customer', color: '#718096', bg: '#f7fafc' },
  resolved:         { label: 'Resolved',         color: '#276749', bg: '#f0fff4' },
  closed:           { label: 'Closed',           color: '#a0aec0', bg: '#edf2f7' },
  escalated:        { label: 'Escalated',        color: '#c53030', bg: '#fff5f5' },
};

export const PRIORITY_META: Record<TicketPriority, { label: string; color: string }> = {
  low:    { label: 'Low',    color: '#718096' },
  normal: { label: 'Normal', color: '#2b6cb0' },
  high:   { label: 'High',   color: '#c05621' },
  urgent: { label: 'Urgent', color: '#c53030' },
};

export const SOURCE_LABEL: Record<TicketSource, string> = {
  calendly:         'Calendly',
  customer_form:    'Form',
  hubspot:          'HubSpot',
  fulfillment_flag: 'Fulfillment',
  ops_manual:       'Manual',
};

// Allowed next-states for the state machine (UI gating)
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  new:              ['triaging', 'in_progress', 'escalated'],
  triaging:         ['in_progress', 'waiting_customer', 'escalated', 'resolved'],
  in_progress:      ['waiting_customer', 'resolved', 'escalated'],
  waiting_customer: ['in_progress', 'resolved'],
  resolved:         ['closed', 'in_progress'],   // re-open if needed
  closed:           ['in_progress'],              // re-open
  escalated:        ['in_progress', 'resolved'],
};

// Warranty helpers
export function warrantyState(lifecycle: Pick<CustomerLifecycle, 'warranty_expires_at'> | null | undefined):
  { state: 'active' | 'expired' | 'na'; daysFromNow: number } {
  if (!lifecycle) return { state: 'na', daysFromNow: 0 };
  const expiresMs = new Date(lifecycle.warranty_expires_at).getTime();
  const nowMs = Date.now();
  const days = Math.round((expiresMs - nowMs) / 86400000);
  return { state: days >= 0 ? 'active' : 'expired', daysFromNow: days };
}

// ============================================================ Hooks

export function useServiceTickets(category?: TicketCategory): {
  tickets: ServiceTicket[];
  loading: boolean;
} {
  const [tickets, setTickets] = useState<ServiceTicket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('service_tickets')
        .select('*')
        .order('created_at', { ascending: false });
      if (category) q = q.eq('category', category);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setTickets(data as ServiceTicket[]);
      setLoading(false);

      channel = supabase
        .channel(`service_tickets:${category ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_tickets' }, (payload) => {
          setTickets(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(t => t.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ServiceTicket;
              if (category && row.category !== category) return prev;
              const idx = prev.findIndex(t => t.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [category]);

  return { tickets, loading };
}

export function useCustomerLifecycle(): { rows: CustomerLifecycle[]; loading: boolean } {
  const [rows, setRows] = useState<CustomerLifecycle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('customer_lifecycle')
        .select('*')
        .order('shipped_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setRows(data as CustomerLifecycle[]);
      setLoading(false);

      channel = supabase
        .channel('customer_lifecycle:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_lifecycle' }, (payload) => {
          setRows(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as CustomerLifecycle;
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { rows, loading };
}

export function useTicketAttachments(ticketId: string | null): {
  attachments: TicketAttachment[];
  loading: boolean;
} {
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setAttachments([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('service_ticket_attachments')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('uploaded_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setAttachments(data as TicketAttachment[]);
      setLoading(false);

      channel = supabase
        .channel(`attachments:${ticketId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'service_ticket_attachments', filter: `ticket_id=eq.${ticketId}` },
          (payload) => {
            setAttachments(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(a => a.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as TicketAttachment;
                const idx = prev.findIndex(a => a.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [ticketId]);

  return { attachments, loading };
}

// ============================================================ Mutations

export async function updateTicketStatus(id: string, status: TicketStatus): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ status }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_status_changed', id, status);
}

export async function assignTicketOwner(id: string, owner_email: string | null): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ owner_email }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_owner_assigned', id, owner_email ?? '(unassigned)');
}

export async function setTicketPriority(id: string, priority: TicketPriority): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ priority }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_priority_set', id, priority);
}

export async function updateTicketNotes(id: string, internal_notes: string): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ internal_notes }).eq('id', id);
  if (error) throw error;
}

export async function setRepairFields(
  id: string,
  patch: { defect_category?: string | null; parts_needed?: string | null },
): Promise<void> {
  const { error } = await supabase.from('service_tickets').update(patch).eq('id', id);
  if (error) throw error;
}

export async function markOnboardingComplete(lifecycleId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'completed', onboarding_completed_at: new Date().toISOString() })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('onboarding_completed', lifecycleId);
}

export async function markOnboardingNoShow(lifecycleId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'no_show' })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('onboarding_no_show', lifecycleId);
}

// Signed URL for displaying an attachment (1 hour expiry).
export async function attachmentSignedUrl(file_path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('ticket-attachments')
    .createSignedUrl(file_path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
```

- [ ] **Step 2: Typecheck**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds (no TS errors).

- [ ] **Step 3: Commit**

```powershell
git add app/src/lib/service.ts
git commit -m "feat(service): lib with types, realtime hooks, mutations`n`nServiceTicket / CustomerLifecycle / TicketAttachment types, three realtime`nhooks, status/owner/priority/notes mutations, warranty computation helper,`nattachment signed-URL fetch.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Edge function — sync-calendly-events

**Files:**
- Create: `supabase/functions/sync-calendly-events/index.ts`
- Modify: `supabase/config.toml` (add `verify_jwt = false` for this function)

- [ ] **Step 1: Write the edge function**

```typescript
// Pull Calendly scheduled events and upsert into service_tickets as
// onboarding tickets. Dedupe by calendly_event_uri (unique). Matches
// invitee email against customers table to attach customer_id when found.
//
// Env: CALENDLY_TOKEN (personal access token, scope: read scheduled events)
//      CALENDLY_USER_URI (e.g. https://api.calendly.com/users/AAA...)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type CalendlyEvent = {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
  status: string;
  event_memberships?: { user_email?: string; user_name?: string }[];
};

type CalendlyInvitee = {
  email?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  text_reminder_number?: string;
};

const PAGE_SIZE = 50;
const MAX_PAGES = 10; // soft cap = 500 events per run

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const calendlyToken = Deno.env.get('CALENDLY_TOKEN');
  const calendlyUserUri = Deno.env.get('CALENDLY_USER_URI');
  if (!supabaseUrl || !serviceKey || !calendlyToken || !calendlyUserUri) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CALENDLY_TOKEN / CALENDLY_USER_URI' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const minStart = new Date(Date.now() - 3600 * 1000).toISOString();         // now - 1h
  const maxStart = new Date(Date.now() + 30 * 86400 * 1000).toISOString();   // now + 30d

  let pageToken: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { uri: string; reason: string }[] = [];

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', calendlyUserUri);
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('min_start_time', minStart);
    url.searchParams.set('max_start_time', maxStart);
    url.searchParams.set('status', 'active');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${calendlyToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `Calendly ${res.status}: ${body.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const json = await res.json() as {
      collection: CalendlyEvent[];
      pagination?: { next_page_token?: string };
    };
    const events = json.collection ?? [];
    fetched += events.length;
    pages++;

    for (const ev of events) {
      // Fetch the first invitee to get customer email
      const inviteesRes = await fetch(`${ev.uri}/invitees`, {
        headers: { Authorization: `Bearer ${calendlyToken}` },
      });
      let invitee: CalendlyInvitee | null = null;
      if (inviteesRes.ok) {
        const inviteesJson = await inviteesRes.json() as { collection: CalendlyInvitee[] };
        invitee = inviteesJson.collection?.[0] ?? null;
      }

      // Find customer_id by email
      let customer_id: string | null = null;
      if (invitee?.email) {
        const { data: cust } = await admin
          .from('customers')
          .select('id')
          .eq('email', invitee.email.toLowerCase())
          .maybeSingle();
        customer_id = cust?.id ?? null;
      }

      const host = ev.event_memberships?.[0];

      const row = {
        category: 'onboarding' as const,
        source: 'calendly' as const,
        status: 'new' as const,
        priority: 'normal' as const,
        customer_id,
        customer_name: invitee?.name ?? null,
        customer_email: invitee?.email?.toLowerCase() ?? null,
        customer_phone: invitee?.text_reminder_number ?? null,
        subject: ev.name || 'Onboarding call',
        description: null,
        calendly_event_uri: ev.uri,
        calendly_event_start: ev.start_time,
        calendly_host_email: host?.user_email ?? null,
      };

      const { error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'calendly_event_uri', ignoreDuplicates: false });
      if (upErr) {
        skipped.push({ uri: ev.uri, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;

      // Bump matching lifecycle row to onboarding_status='scheduled'
      if (customer_id) {
        await admin
          .from('customer_lifecycle')
          .update({ onboarding_status: 'scheduled' })
          .eq('customer_id', customer_id)
          .eq('onboarding_status', 'not_scheduled');
      }
    }

    pageToken = json.pagination?.next_page_token;
    if (!pageToken) break;
  }

  return new Response(
    JSON.stringify({ pages, fetched, upserted, skipped: skipped.length, skippedDetails: skipped.slice(0, 20) }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
```

- [ ] **Step 2: Add config entry**

Edit `supabase/config.toml` and add:

```toml
[functions.sync-calendly-events]
verify_jwt = false
```

- [ ] **Step 3: Deploy edge function**

```powershell
& app/node_modules/.bin/supabase functions deploy sync-calendly-events --project-ref txeftbbzeflequvrmjjr
```

Expected: `Deployed function sync-calendly-events`.

- [ ] **Step 4: Set Calendly secrets (manual one-time)**

In Supabase Studio → Project Settings → Edge Functions → Secrets, add:
- `CALENDLY_TOKEN` = Calendly personal access token
- `CALENDLY_USER_URI` = e.g. `https://api.calendly.com/users/AAA-XXX...`

If tokens aren't provisioned yet, leave a placeholder note in the function logs (it returns `Missing ...` 500) and proceed with the next task — the function will work once secrets are filled in.

- [ ] **Step 5: Manual smoke test**

```powershell
$SUPABASE_URL = "https://txeftbbzeflequvrmjjr.supabase.co"
$ANON = "<anon_key_from_supabase>"
curl.exe -X POST "$SUPABASE_URL/functions/v1/sync-calendly-events" `
  -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{}'
```

Expected (once secrets are set): JSON with `pages`, `fetched`, `upserted`. If secrets not yet set, expect the `Missing ...` 500 response — that confirms the function deployed.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/sync-calendly-events/index.ts supabase/config.toml
git commit -m "feat(service): sync-calendly-events edge function`n`nPulls /scheduled_events for the next 30 days, upserts into service_tickets`nas onboarding tickets (deduped on calendly_event_uri), matches invitee`nemail against customers, bumps lifecycle.onboarding_status to scheduled.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Edge function — sync-hubspot-tickets

**Files:**
- Create: `supabase/functions/sync-hubspot-tickets/index.ts`
- Modify: `supabase/config.toml` (add `verify_jwt = false` for this function)

- [ ] **Step 1: Write the edge function**

```typescript
// Pull HubSpot CRM tickets and upsert into service_tickets. Phase 1:
// inbound only (HubSpot is source of truth, we mirror). Dedupe by
// hubspot_ticket_id (unique). Matches associated contact email against
// customers table to attach customer_id when found.
//
// Env: HUBSPOT_ACCESS_TOKEN (private app token, scope: tickets.read)
//
// Pipeline stage → status mapping (HubSpot defaults):
//   1 (New)              → new
//   2 (Waiting on contact)→ waiting_customer
//   3 (Waiting on us)    → in_progress
//   4 (Closed)           → resolved
// Other stage ids fall through to 'new'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type HubspotTicket = {
  id: string;
  properties: {
    subject?: string | null;
    content?: string | null;
    hs_pipeline?: string | null;
    hs_pipeline_stage?: string | null;
    hs_ticket_priority?: string | null;   // HIGH | MEDIUM | LOW
    hs_ticket_category?: string | null;
    createdate?: string | null;
    hubspot_owner_id?: string | null;
    [k: string]: string | null | undefined;
  };
};

const PROPERTIES = [
  'subject','content','hs_pipeline','hs_pipeline_stage',
  'hs_ticket_priority','hs_ticket_category','createdate','hubspot_owner_id',
];
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // soft cap = 2,000 tickets per run

function mapStage(stage: string | null | undefined): 'new' | 'waiting_customer' | 'in_progress' | 'resolved' {
  switch (stage) {
    case '2': return 'waiting_customer';
    case '3': return 'in_progress';
    case '4': return 'resolved';
    default:  return 'new';
  }
}
function mapPriority(p: string | null | undefined): 'low' | 'normal' | 'high' | 'urgent' {
  switch ((p ?? '').toUpperCase()) {
    case 'HIGH':   return 'high';
    case 'LOW':    return 'low';
    case 'URGENT': return 'urgent';
    default:       return 'normal';
  }
}
function mapCategory(c: string | null | undefined): 'support' | 'repair' {
  if (!c) return 'support';
  const v = c.toLowerCase();
  if (v.includes('repair') || v.includes('defect') || v.includes('hardware')) return 'repair';
  return 'support';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const hubspotToken = Deno.env.get('HUBSPOT_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceKey || !hubspotToken) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / HUBSPOT_ACCESS_TOKEN' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let after: string | undefined = undefined;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  const skipped: { id: string; reason: string }[] = [];

  while (pages < MAX_PAGES) {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/tickets');
    url.searchParams.set('limit', String(PAGE_SIZE));
    for (const p of PROPERTIES) url.searchParams.append('properties', p);
    url.searchParams.set('associations', 'contacts');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `HubSpot ${res.status}: ${body.slice(0, 400)}` }),
        { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
      );
    }
    const json = await res.json() as {
      results: (HubspotTicket & { associations?: { contacts?: { results?: { id: string }[] } } })[];
      paging?: { next?: { after?: string } };
    };
    const results = json.results ?? [];
    fetched += results.length;
    pages++;

    for (const t of results) {
      const p = t.properties ?? {};
      if (!p.subject) {
        skipped.push({ id: t.id, reason: 'no subject' });
        continue;
      }

      // Resolve associated contact → customer
      let customer_id: string | null = null;
      let customer_email: string | null = null;
      let customer_name: string | null = null;
      const contactId = t.associations?.contacts?.results?.[0]?.id;
      if (contactId) {
        const { data: cust } = await admin
          .from('customers')
          .select('id, email, first_name, last_name')
          .eq('hubspot_id', contactId)
          .maybeSingle();
        if (cust) {
          customer_id = cust.id;
          customer_email = cust.email;
          customer_name = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || null;
        }
      }

      const row = {
        hubspot_ticket_id: t.id,
        category: mapCategory(p.hs_ticket_category),
        source: 'hubspot' as const,
        status: mapStage(p.hs_pipeline_stage),
        priority: mapPriority(p.hs_ticket_priority),
        customer_id,
        customer_name,
        customer_email,
        subject: p.subject ?? '(no subject)',
        description: p.content ?? null,
      };

      const { error: upErr } = await admin
        .from('service_tickets')
        .upsert(row, { onConflict: 'hubspot_ticket_id', ignoreDuplicates: false });
      if (upErr) {
        skipped.push({ id: t.id, reason: `db: ${upErr.message}` });
        continue;
      }
      upserted++;
    }

    after = json.paging?.next?.after;
    if (!after) break;
  }

  return new Response(
    JSON.stringify({ pages, fetched, upserted, skipped: skipped.length, skippedDetails: skipped.slice(0, 20) }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}
```

- [ ] **Step 2: Add config entry**

Edit `supabase/config.toml` and add:

```toml
[functions.sync-hubspot-tickets]
verify_jwt = false
```

- [ ] **Step 3: Deploy**

```powershell
& app/node_modules/.bin/supabase functions deploy sync-hubspot-tickets --project-ref txeftbbzeflequvrmjjr
```

Expected: `Deployed function sync-hubspot-tickets`.

- [ ] **Step 4: HubSpot token scope check**

The existing `HUBSPOT_ACCESS_TOKEN` was provisioned for contacts. Confirm it has the `tickets.read` scope. If not, regenerate the private app token with both scopes and re-set the secret. (No code change needed.)

- [ ] **Step 5: Manual smoke test**

```powershell
curl.exe -X POST "https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/sync-hubspot-tickets" `
  -H "Authorization: Bearer <anon_key>" -H "Content-Type: application/json" -d '{}'
```

Expected: JSON with `pages`, `fetched`, `upserted`. If scope is missing, HubSpot returns 403 with a message identifying the missing scope.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/sync-hubspot-tickets/index.ts supabase/config.toml
git commit -m "feat(service): sync-hubspot-tickets edge function`n`nPhase 1 inbound-only HubSpot ticket sync. Pipeline stage → our status,`nticket priority enum mapping, category inferred from hs_ticket_category.`nAssociated contact resolved to customers via hubspot_id.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: pg_cron schedules + template auto-fire trigger

**Files:**
- Create: `supabase/migrations/20260512130000_service_pg_cron.sql`

- [ ] **Step 1: Write the migration**

```sql
-- pg_cron + pg_net wiring for periodic syncs and template auto-fires.
-- Requires pg_cron and pg_net extensions enabled on the project (already
-- enabled for existing email auto-fire flows in this project).

-- ============================================================ Extension check
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============================================================ Helper: call edge function
create or replace function public.invoke_edge_function(fn_name text, body jsonb default '{}'::jsonb)
returns void language plpgsql security definer as $$
declare
  base_url text := current_setting('app.supabase_url', true);
  anon_key text := current_setting('app.supabase_anon_key', true);
begin
  -- These two GUCs must be set on the database: see Step 2.
  if base_url is null or anon_key is null then
    raise warning 'invoke_edge_function: app.supabase_url / app.supabase_anon_key not configured';
    return;
  end if;
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := body
  );
end $$;

-- ============================================================ Cron: Calendly hourly
select cron.unschedule('sync-calendly-hourly') where exists (
  select 1 from cron.job where jobname = 'sync-calendly-hourly'
);
select cron.schedule(
  'sync-calendly-hourly',
  '15 * * * *',                                       -- every hour at :15
  $$ select public.invoke_edge_function('sync-calendly-events'); $$
);

-- ============================================================ Cron: HubSpot hourly
select cron.unschedule('sync-hubspot-tickets-hourly') where exists (
  select 1 from cron.job where jobname = 'sync-hubspot-tickets-hourly'
);
select cron.schedule(
  'sync-hubspot-tickets-hourly',
  '30 * * * *',                                       -- every hour at :30 (stagger)
  $$ select public.invoke_edge_function('sync-hubspot-tickets'); $$
);

-- ============================================================ Cron: auto-close
-- 7 days after resolved → closed. Runs daily at 03:00 UTC.
select cron.unschedule('service-tickets-auto-close') where exists (
  select 1 from cron.job where jobname = 'service-tickets-auto-close'
);
select cron.schedule(
  'service-tickets-auto-close',
  '0 3 * * *',
  $$
    update public.service_tickets
       set status = 'closed',
           closed_at = now()
     where status = 'resolved'
       and resolved_at < now() - interval '7 days'
  $$
);

-- ============================================================ Template auto-fire trigger
-- Fires send-template-email for the transitions documented in the spec:
--   * INSERT category='onboarding' source='calendly' → onboarding_calendly_confirmation
--   * INSERT category='repair' → repair_acknowledged
--   * INSERT category='onboarding' source!='calendly' → no auto (created by ops)
--   * UPDATE status to 'triaging' on category='support' → support_received
--
-- Variables collected from the ticket row + customer_lifecycle if linked.
create or replace function public.tickets_fire_templates() returns trigger language plpgsql security definer as $$
declare
  tmpl text;
  vars jsonb := '{}'::jsonb;
  lifecycle record;
begin
  -- Pick the template
  if tg_op = 'INSERT' then
    if new.category = 'onboarding' and new.source = 'calendly' then
      tmpl := 'onboarding_calendly_confirmation';
    elsif new.category = 'repair' then
      tmpl := 'repair_acknowledged';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.category = 'support' and old.status is distinct from new.status and new.status = 'triaging' then
      tmpl := 'support_received';
    end if;
  end if;
  if tmpl is null then return new; end if;
  if new.customer_email is null then return new; end if;

  -- Build variables
  select * into lifecycle from public.customer_lifecycle where unit_serial = new.unit_serial limit 1;
  vars := jsonb_build_object(
    'customer_first_name', coalesce(split_part(new.customer_name, ' ', 1), 'there'),
    'unit_serial',         coalesce(new.unit_serial, ''),
    'ticket_number',       new.ticket_number,
    'subject',             new.subject,
    'event_start_local',   to_char(new.calendly_event_start at time zone 'America/Vancouver', 'FMDay, FMMonth FMDD at HH12:MI AM'),
    'event_timezone',      'America/Vancouver',
    'event_url',           coalesce(new.calendly_event_uri, ''),
    'host_name',           coalesce(new.calendly_host_email, '')
  );

  perform public.invoke_edge_function(
    'send-template-email',
    jsonb_build_object(
      'template_key', tmpl,
      'to',           new.customer_email,
      'to_name',      new.customer_name,
      'variables',    vars
    )
  );
  return new;
end $$;

drop trigger if exists tickets_template_autofire_ins on public.service_tickets;
create trigger tickets_template_autofire_ins
  after insert on public.service_tickets
  for each row execute function public.tickets_fire_templates();

drop trigger if exists tickets_template_autofire_upd on public.service_tickets;
create trigger tickets_template_autofire_upd
  after update on public.service_tickets
  for each row execute function public.tickets_fire_templates();

-- ============================================================ Onboarding-welcome on lifecycle insert
create or replace function public.lifecycle_fire_welcome() returns trigger language plpgsql security definer as $$
declare
  cust record;
begin
  if new.customer_id is null then return new; end if;
  select * into cust from public.customers where id = new.customer_id;
  if cust.email is null then return new; end if;
  perform public.invoke_edge_function(
    'send-template-email',
    jsonb_build_object(
      'template_key', 'onboarding_welcome',
      'to',           cust.email,
      'to_name',      trim(coalesce(cust.first_name, '') || ' ' || coalesce(cust.last_name, '')),
      'variables',    jsonb_build_object(
        'customer_first_name', coalesce(cust.first_name, 'there'),
        'unit_serial',         coalesce(new.unit_serial, '')
      )
    )
  );
  return new;
end $$;

drop trigger if exists lifecycle_fire_welcome on public.customer_lifecycle;
create trigger lifecycle_fire_welcome
  after insert on public.customer_lifecycle
  for each row execute function public.lifecycle_fire_welcome();
```

- [ ] **Step 2: Set GUC parameters (one-time, run in Supabase SQL editor)**

```sql
alter database postgres set app.supabase_url = 'https://txeftbbzeflequvrmjjr.supabase.co';
alter database postgres set app.supabase_anon_key = '<paste anon key here>';
-- Reset existing connections so the new GUCs take effect:
select pg_reload_conf();
```

(This is a one-time DB config — already done for other projects; if `app.supabase_url` is already set, skip.)

- [ ] **Step 3: Apply migration**

```powershell
& app/node_modules/.bin/supabase db push --linked
```

Expected: 3 cron jobs scheduled, 2 trigger functions created. Look for no `ERROR:` lines.

- [ ] **Step 4: Verify cron jobs**

```sql
select jobname, schedule, active from cron.job where jobname like 'sync-%' or jobname like 'service-%';
```

Expected: 3 rows, all `active=true`.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260512130000_service_pg_cron.sql
git commit -m "feat(service): pg_cron schedules + template auto-fire triggers`n`nHourly Calendly + HubSpot polls (staggered :15/:30), daily auto-close at`n03:00 UTC. Triggers fire onboarding_calendly_confirmation,`nrepair_acknowledged, support_received, and onboarding_welcome (on`nlifecycle insert) via existing send-template-email function.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Service module shell + route + nav + CSS

**Files:**
- Create: `app/src/modules/Service/index.tsx`
- Create: `app/src/modules/Service/Service.module.css`
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/GlobalNav.tsx`

- [ ] **Step 1: Write Service.module.css**

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
.tabs {
  display: flex;
  gap: 2px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  padding: 0 12px;
}
.tab {
  background: transparent;
  border: none;
  padding: 12px 18px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--color-ink-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tab:hover { color: var(--color-ink); }
.tab.active {
  color: var(--color-crimson);
  border-bottom-color: var(--color-crimson);
}
.panel { padding: 18px 20px; }

/* ============================================================ KPI strip */
.kpiStrip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.kpiCard {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.kpiLabel {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-ink-subtle);
}
.kpiValue {
  font-size: 22px;
  font-weight: 800;
  color: var(--color-ink);
  margin-top: 2px;
}

/* ============================================================ Filter chips + search */
.filterRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 10px;
}
.chip {
  border: 1px solid var(--color-border);
  background: #fff;
  color: var(--color-ink-muted);
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.chip:hover { border-color: var(--color-ink-subtle); color: var(--color-ink); }
.chipActive {
  background: var(--color-crimson);
  color: #fff;
  border-color: var(--color-crimson);
}
.search {
  flex: 1;
  min-width: 200px;
  margin-left: auto;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-family: inherit;
}
.search:focus { outline: none; border-color: var(--color-crimson); }

/* ============================================================ Tables */
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.table th {
  text-align: left;
  background: var(--color-surface);
  padding: 7px 10px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--color-ink-subtle);
  border-bottom: 1px solid var(--color-border);
}
.table td {
  padding: 8px 10px;
  border-bottom: 1px solid #f0eee8;
  vertical-align: top;
}
.row { cursor: pointer; }
.row:hover { background: rgba(204, 45, 48, 0.04); }
.rowSelected { background: rgba(204, 45, 48, 0.08); }

/* ============================================================ Status / category / priority pills */
.pill {
  display: inline-block;
  font-size: 9px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 10px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.warrantyPill {
  display: inline-block;
  font-size: 9px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 10px;
  letter-spacing: 0.3px;
}
.warrantyActive  { background: #f0fff4; color: #276749; }
.warrantyExpired { background: #edf2f7; color: #4a5568; }
.warrantyNa      { background: #f7fafc; color: #a0aec0; }

/* ============================================================ Detail panel (slide-over) */
.detailOverlay {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 480px;
  background: #fff;
  border-left: 1px solid var(--color-border);
  box-shadow: -4px 0 16px rgba(0,0,0,0.08);
  z-index: 80;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.detailHead {
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}
.detailTicketNum {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--color-ink-subtle);
  margin-bottom: 4px;
}
.detailSubject {
  font-size: 15px;
  font-weight: 800;
  color: var(--color-ink);
  margin: 0;
}
.detailMetaRow {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.detailClose {
  background: transparent;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--color-ink-subtle);
  line-height: 1;
}
.detailBody {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 20px;
}
.detailSection {
  margin-bottom: 16px;
}
.detailSectionLabel {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--color-ink-subtle);
  margin-bottom: 6px;
}
.detailValue {
  font-size: 12px;
  color: var(--color-ink);
  line-height: 1.55;
  white-space: pre-wrap;
}
.detailFieldGrid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
.detailFieldLabel {
  color: var(--color-ink-subtle);
  font-weight: 600;
}
.detailFieldValue { color: var(--color-ink); }

.actionsRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.btnPrimary {
  background: var(--color-crimson);
  color: #fff;
  border: none;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.btnPrimary:hover { background: var(--color-crimson-dark); }
.btnSecondary {
  background: #fff;
  color: var(--color-ink-muted);
  border: 1px solid var(--color-border);
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.btnSecondary:hover { border-color: var(--color-ink-subtle); color: var(--color-ink); }
.btnGhost {
  background: transparent;
  border: none;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-crimson);
  cursor: pointer;
}
.btnGhost:hover { text-decoration: underline; }

.select, .input, .textarea {
  padding: 6px 9px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-family: inherit;
  width: 100%;
  background: #fff;
}
.select:focus, .input:focus, .textarea:focus {
  outline: none; border-color: var(--color-crimson);
}
.textarea { resize: vertical; min-height: 60px; line-height: 1.5; }

/* ============================================================ Attachment strip */
.attachStrip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.attachThumb {
  width: 100px;
  height: 100px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  cursor: pointer;
  position: relative;
}
.attachThumb img, .attachThumb video {
  width: 100%; height: 100%; object-fit: cover;
}
.attachThumb .badge {
  position: absolute;
  bottom: 4px; right: 4px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 4px;
}
.attachFile {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  text-decoration: none;
  color: var(--color-ink);
}
.attachLightbox {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.85);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.attachLightbox img, .attachLightbox video {
  max-width: 90vw; max-height: 90vh;
}

/* ============================================================ Empty / loading */
.empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--color-ink-subtle);
  font-size: 13px;
}
.loading {
  padding: 40px;
  text-align: center;
  color: var(--color-ink-subtle);
  font-size: 13px;
}
```

- [ ] **Step 2: Write index.tsx (module shell)**

```typescript
import { useState } from 'react';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import { RepairTab } from './RepairTab';
import styles from './Service.module.css';

type Tab = 'onboarding' | 'support' | 'repair';

const TABS: { key: Tab; label: string }[] = [
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'support',    label: 'Support' },
  { key: 'repair',     label: 'Repair' },
];

export default function Service() {
  const [tab, setTab] = useState<Tab>('support');

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.active : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>
      <div className={styles.panel}>
        {tab === 'onboarding' && <OnboardingTab />}
        {tab === 'support'    && <SupportTab />}
        {tab === 'repair'     && <RepairTab />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire route in App.tsx**

Edit `app/src/App.tsx` — add import + route. Show the relevant region (current `App.tsx` has `<Route path="post-shipment" element={<PostShipment />} />` near line 37):

```typescript
import OrderReview from './modules/OrderReview';
import Fulfillment from './modules/Fulfillment';
import PostShipment from './modules/PostShipment';
import Service from './modules/Service';                  // NEW
import Stock from './modules/Stock';
import Customers from './modules/Customers';
// ...

// Inside the <Route path="/"> protected group, after post-shipment:
<Route path="post-shipment" element={<PostShipment />} />
<Route path="service"       element={<Service />} />      // NEW
<Route path="stock"         element={<Stock />} />
```

(The `/service-request` public form route is added later in Task 13. Don't add it now.)

- [ ] **Step 4: Add to GlobalNav**

Edit `app/src/components/GlobalNav.tsx`:

```typescript
const MODULES = [
  { path: '/order-review',  label: 'Order Review' },
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/post-shipment', label: 'Post-Shipment' },
  { path: '/service',       label: 'Service' },        // NEW
  { path: '/stock',         label: 'Stock' },
  { path: '/customers',     label: 'Customers' },
  { path: '/templates',     label: 'Templates' },
  { path: '/activity-log',  label: 'Activity Log' },
];
```

- [ ] **Step 5: Create placeholder tab files so build passes**

Create three throwaway placeholders the next tasks will overwrite — needed so the imports compile:

`app/src/modules/Service/OnboardingTab.tsx`:
```typescript
export function OnboardingTab() {
  return <div>Onboarding tab — built in Task 11.</div>;
}
```

`app/src/modules/Service/SupportTab.tsx`:
```typescript
export function SupportTab() {
  return <div>Support tab — built in Task 10.</div>;
}
```

`app/src/modules/Service/RepairTab.tsx`:
```typescript
export function RepairTab() {
  return <div>Repair tab — built in Task 12.</div>;
}
```

- [ ] **Step 6: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 7: Manual verify**

```powershell
cd app; npm run dev
```

Open `http://localhost:5173/service`, confirm 3-tab shell renders. Confirm "Service" appears in the global nav between Post-Shipment and Stock.

Then Ctrl+C to stop the dev server.

- [ ] **Step 8: Commit**

```powershell
git add app/src/modules/Service app/src/App.tsx app/src/components/GlobalNav.tsx
git commit -m "feat(service): module shell + route + nav entry`n`nThree-tab layout (Onboarding/Support/Repair), CSS for KPIs/tables/pills/`ndetail-panel/attachment-strip. Placeholder tab files; real tabs follow.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: AttachmentStrip component

**Files:**
- Create: `app/src/modules/Service/AttachmentStrip.tsx`

- [ ] **Step 1: Write the component**

```typescript
import { useEffect, useState } from 'react';
import { useTicketAttachments, attachmentSignedUrl } from '../../lib/service';
import type { TicketAttachment } from '../../lib/service';
import styles from './Service.module.css';

type Props = { ticketId: string };

export function AttachmentStrip({ ticketId }: Props) {
  const { attachments, loading } = useTicketAttachments(ticketId);
  const [lightbox, setLightbox] = useState<TicketAttachment | null>(null);

  if (loading) return <div className={styles.loading}>Loading attachments…</div>;
  if (attachments.length === 0) return <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No attachments</div>;

  return (
    <>
      <div className={styles.attachStrip}>
        {attachments.map(a => (
          <AttachmentTile key={a.id} att={a} onClick={() => setLightbox(a)} />
        ))}
      </div>
      {lightbox && <Lightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function AttachmentTile({ att, onClick }: { att: TicketAttachment; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);

  const isImage = att.mime_type.startsWith('image/');
  const isVideo = att.mime_type.startsWith('video/');
  const sizeLabel = att.size_bytes > 1_000_000
    ? `${(att.size_bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(att.size_bytes / 1000)} KB`;

  if (!url) {
    return <div className={styles.attachThumb} style={{ opacity: 0.5 }} />;
  }

  if (isImage) {
    return (
      <div className={styles.attachThumb} onClick={onClick}>
        <img src={url} alt={att.file_name} />
        <span className={`${styles.pill} badge`}>IMG</span>
      </div>
    );
  }
  if (isVideo) {
    return (
      <div className={styles.attachThumb} onClick={onClick}>
        <video src={url} muted />
        <span className={`${styles.pill} badge`}>{sizeLabel}</span>
      </div>
    );
  }
  return (
    <a href={url} download={att.file_name} className={styles.attachFile}>
      📎 {att.file_name}
    </a>
  );
}

function Lightbox({ att, onClose }: { att: TicketAttachment; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);

  if (!url) return null;
  const isVideo = att.mime_type.startsWith('video/');
  return (
    <div className={styles.attachLightbox} onClick={onClose}>
      {isVideo
        ? <video src={url} controls autoPlay onClick={(e) => e.stopPropagation()} />
        : <img src={url} alt={att.file_name} onClick={(e) => e.stopPropagation()} />}
    </div>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```powershell
git add app/src/modules/Service/AttachmentStrip.tsx
git commit -m "feat(service): AttachmentStrip with image/video thumbnails + lightbox`n`nImages render as cover-fit thumbnails, videos show muted preview with`nsize badge, click opens a click-to-close lightbox (autoplays video).`nNon-image/video falls back to a download link.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: SupportTab — full implementation

**Files:**
- Modify: `app/src/modules/Service/SupportTab.tsx`
- Create: `app/src/modules/Service/TicketDetailPanel.tsx`

- [ ] **Step 1: Write TicketDetailPanel**

```typescript
import { useState } from 'react';
import {
  type ServiceTicket, type TicketStatus,
  STATUS_META, CATEGORY_META, PRIORITY_META, SOURCE_LABEL, NEXT_STATUSES,
  updateTicketStatus, assignTicketOwner, setTicketPriority,
  updateTicketNotes, setRepairFields,
  useCustomerLifecycle, warrantyState,
} from '../../lib/service';
import { AttachmentStrip } from './AttachmentStrip';
import styles from './Service.module.css';

const OPS_OWNERS = [
  'george@virgohome.io',
  'julie@virgohome.io',
  'ashwini@virgohome.io',
  'junaid@virgohome.io',
  'aaron@virgohome.io',
  'raymond@virgohome.io',
  'huayi@virgohome.io',
];

type Props = {
  ticket: ServiceTicket;
  onClose: () => void;
};

export function TicketDetailPanel({ ticket, onClose }: Props) {
  const [notes, setNotes] = useState(ticket.internal_notes ?? '');
  const [defectCat, setDefectCat] = useState(ticket.defect_category ?? '');
  const [parts, setParts] = useState(ticket.parts_needed ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { rows: lifecycle } = useCustomerLifecycle();
  const lifecycleRow = ticket.unit_serial ? lifecycle.find(l => l.unit_serial === ticket.unit_serial) : null;
  const warranty = warrantyState(lifecycleRow ?? null);

  const cat = CATEGORY_META[ticket.category];
  const status = STATUS_META[ticket.status];
  const prio = PRIORITY_META[ticket.priority];

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
          <div className={styles.detailTicketNum}>{ticket.ticket_number}</div>
          <h3 className={styles.detailSubject}>{ticket.subject}</h3>
          <div className={styles.detailMetaRow}>
            <span className={styles.pill} style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
            <span className={styles.pill} style={{ background: status.bg, color: status.color }}>{status.label}</span>
            <span className={styles.pill} style={{ background: '#f7fafc', color: prio.color }}>{prio.label}</span>
            <span className={styles.pill} style={{ background: '#edf2f7', color: '#4a5568' }}>
              {SOURCE_LABEL[ticket.source]}
            </span>
            <span
              className={`${styles.warrantyPill} ${
                warranty.state === 'active'  ? styles.warrantyActive  :
                warranty.state === 'expired' ? styles.warrantyExpired :
                                               styles.warrantyNa
              }`}
              title={lifecycleRow ? `Expires ${new Date(lifecycleRow.warranty_expires_at).toLocaleDateString()}` : ''}
            >
              {warranty.state === 'active'  && `Warranty • ${warranty.daysFromNow}d left`}
              {warranty.state === 'expired' && `Warranty expired ${Math.abs(warranty.daysFromNow)}d ago`}
              {warranty.state === 'na'      && 'No unit linked'}
            </span>
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>
        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Customer</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Name</span>
            <span className={styles.detailFieldValue}>{ticket.customer_name ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Email</span>
            <span className={styles.detailFieldValue}>{ticket.customer_email ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Phone</span>
            <span className={styles.detailFieldValue}>{ticket.customer_phone ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Unit serial</span>
            <span className={styles.detailFieldValue}>{ticket.unit_serial ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Order ref</span>
            <span className={styles.detailFieldValue}>{ticket.order_ref ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Created</span>
            <span className={styles.detailFieldValue}>{new Date(ticket.created_at).toLocaleString()}</span>
          </div>
        </div>

        {ticket.description && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Description</div>
            <div className={styles.detailValue}>{ticket.description}</div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Attachments</div>
          <AttachmentStrip ticketId={ticket.id} />
        </div>

        {ticket.category === 'repair' && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Repair details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select className={styles.select} value={defectCat} onChange={e => setDefectCat(e.target.value)}>
                <option value="">— Defect category —</option>
                <option value="Door">Door</option>
                <option value="Auger">Auger</option>
                <option value="Heater">Heater</option>
                <option value="Sensor">Sensor</option>
                <option value="Wiring">Wiring</option>
                <option value="Other">Other</option>
              </select>
              <textarea
                className={styles.textarea}
                placeholder="Parts needed (free-text)"
                value={parts}
                onChange={e => setParts(e.target.value)}
              />
              <button
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => run(setRepairFields(ticket.id, { defect_category: defectCat || null, parts_needed: parts || null }))}
              >Save repair details</button>
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Status — transition</div>
          <div className={styles.actionsRow}>
            {NEXT_STATUSES[ticket.status].map(next => (
              <button
                key={next}
                className={styles.btnPrimary}
                disabled={busy}
                onClick={() => run(updateTicketStatus(ticket.id, next as TicketStatus))}
              >→ {STATUS_META[next].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Owner</div>
          <select
            className={styles.select}
            value={ticket.owner_email ?? ''}
            disabled={busy}
            onChange={(e) => void run(assignTicketOwner(ticket.id, e.target.value || null))}
          >
            <option value="">— Unassigned —</option>
            {OPS_OWNERS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Priority</div>
          <div className={styles.actionsRow}>
            {(['low','normal','high','urgent'] as const).map(p => (
              <button
                key={p}
                className={ticket.priority === p ? styles.btnPrimary : styles.btnSecondary}
                disabled={busy}
                onClick={() => run(setTicketPriority(ticket.id, p))}
              >{PRIORITY_META[p].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Internal notes</div>
          <textarea
            className={styles.textarea}
            placeholder="Internal notes (ops only)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
          <div className={styles.actionsRow}>
            <button
              className={styles.btnSecondary}
              disabled={busy}
              onClick={() => run(updateTicketNotes(ticket.id, notes))}
            >Save notes</button>
          </div>
        </div>

        {ticket.hubspot_ticket_id && (
          <div className={styles.detailSection}>
            <a
              className={styles.btnGhost}
              href={`https://app.hubspot.com/contacts/_/tickets/${ticket.hubspot_ticket_id}`}
              target="_blank"
              rel="noreferrer"
            >Open in HubSpot ↗</a>
          </div>
        )}

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Overwrite SupportTab.tsx**

```typescript
import { useMemo, useState } from 'react';
import {
  useServiceTickets, STATUS_META, PRIORITY_META, SOURCE_LABEL,
  type TicketStatus, type ServiceTicket,
} from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const STATUS_FILTERS: { key: TicketStatus | 'all'; label: string }[] = [
  { key: 'all',              label: 'All' },
  { key: 'new',              label: 'New' },
  { key: 'triaging',         label: 'Triaging' },
  { key: 'in_progress',      label: 'In progress' },
  { key: 'waiting_customer', label: 'Waiting customer' },
  { key: 'resolved',         label: 'Resolved' },
];

export function SupportTab() {
  const { tickets, loading } = useServiceTickets('support');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot'>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (q) {
        const needle = q.toLowerCase();
        return (
          t.subject.toLowerCase().includes(needle) ||
          (t.customer_name ?? '').toLowerCase().includes(needle) ||
          (t.customer_email ?? '').toLowerCase().includes(needle) ||
          t.ticket_number.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [tickets, statusFilter, sourceFilter, q]);

  const selected = filtered.find(t => t.id === selectedId) ?? tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const dayAgo = Date.now() - 86400_000;
  const weekAgo = Date.now() - 7 * 86400_000;
  const newTodayCount = tickets.filter(t => new Date(t.created_at).getTime() > dayAgo).length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const waitingCount = tickets.filter(t => t.status === 'waiting_customer').length;
  const resolvedWeekCount = tickets.filter(t =>
    t.status === 'resolved' && t.resolved_at && new Date(t.resolved_at).getTime() > weekAgo
  ).length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="New (24h)"     value={newTodayCount} />
        <Kpi label="In progress"   value={inProgressCount} />
        <Kpi label="Waiting cust." value={waitingCount} />
        <Kpi label="Resolved (7d)" value={resolvedWeekCount} />
      </div>

      <div className={styles.filterRow}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${statusFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setStatusFilter(f.key)}
          >{f.label}</button>
        ))}
        <button
          className={`${styles.chip} ${sourceFilter === 'all' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('all')}
        >Any source</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'customer_form' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('customer_form')}
        >Form</button>
        <button
          className={`${styles.chip} ${sourceFilter === 'hubspot' ? styles.chipActive : ''}`}
          onClick={() => setSourceFilter('hubspot')}
        >HubSpot</button>
        <input
          className={styles.search}
          placeholder="Search ticket #, subject, customer…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No tickets match these filters.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Created</th>
              <th>Customer</th>
              <th>Subject</th>
              <th>Source</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <TicketRow key={t.id} t={t}
                selected={selectedId === t.id}
                onClick={() => setSelectedId(t.id)} />
            ))}
          </tbody>
        </table>
      )}

      {selected && <TicketDetailPanel ticket={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function TicketRow({ t, selected, onClick }: { t: ServiceTicket; selected: boolean; onClick: () => void }) {
  const s = STATUS_META[t.status];
  const p = PRIORITY_META[t.priority];
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
    >
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td>{t.subject}</td>
      <td>{SOURCE_LABEL[t.source]}</td>
      <td><span className={styles.pill} style={{ background: '#f7fafc', color: p.color }}>{p.label}</span></td>
      <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
    </tr>
  );
}
```

- [ ] **Step 3: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 4: Manual verify**

`npm run dev` in `app/`, open `/service`, switch to Support tab. With no support tickets yet, expect empty state. Insert a test row via SQL:

```sql
insert into public.service_tickets (category, source, subject, customer_name, customer_email)
values ('support', 'customer_form', 'Test ticket', 'Test Customer', 'test@example.com');
```

Refresh — should appear. Click it → detail panel slides in. Try status transition buttons → realtime updates the row.

Roll back: `delete from public.service_tickets where customer_email='test@example.com';`

- [ ] **Step 5: Commit**

```powershell
git add app/src/modules/Service/SupportTab.tsx app/src/modules/Service/TicketDetailPanel.tsx
git commit -m "feat(service): Support tab + shared TicketDetailPanel`n`nKPI strip, status + source filter chips, search, click-to-select row,`nslide-over detail panel with status transitions gated by state machine,`nowner/priority/notes mutations, attachment strip, warranty pill, HubSpot`ndeep-link.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: OnboardingTab

**Files:**
- Modify: `app/src/modules/Service/OnboardingTab.tsx`

- [ ] **Step 1: Overwrite OnboardingTab.tsx**

```typescript
import { useMemo, useState } from 'react';
import {
  useServiceTickets, useCustomerLifecycle,
  STATUS_META, warrantyState,
  markOnboardingComplete, markOnboardingNoShow,
  type ServiceTicket,
} from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

export function OnboardingTab() {
  const { tickets, loading } = useServiceTickets('onboarding');
  const { rows: lifecycle, loading: lcLoading } = useCustomerLifecycle();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'tickets' | 'lifecycle'>('tickets');

  const selected = tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const weekFromNow = Date.now() + 7 * 86400_000;
  const monthAgo = Date.now() - 30 * 86400_000;
  const scheduledThisWeek = tickets.filter(t =>
    t.calendly_event_start && new Date(t.calendly_event_start).getTime() < weekFromNow && t.status !== 'closed'
  ).length;
  const completedThisMonth = lifecycle.filter(l =>
    l.onboarding_status === 'completed' && l.onboarding_completed_at &&
    new Date(l.onboarding_completed_at).getTime() > monthAgo
  ).length;
  const noShows = lifecycle.filter(l => l.onboarding_status === 'no_show').length;

  const avgDaysToOnboard = useMemo(() => {
    const completed = lifecycle.filter(l => l.onboarding_status === 'completed' && l.onboarding_completed_at);
    if (completed.length === 0) return null;
    const totalDays = completed.reduce((sum, l) => {
      const days = (new Date(l.onboarding_completed_at!).getTime() - new Date(l.shipped_at).getTime()) / 86400_000;
      return sum + days;
    }, 0);
    return Math.round(totalDays / completed.length);
  }, [lifecycle]);

  if (loading || lcLoading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Scheduled (7d)"  value={scheduledThisWeek} />
        <Kpi label="Completed (30d)" value={completedThisMonth} />
        <Kpi label="No-shows"        value={noShows} />
        <Kpi label="Avg ship → onboard" value={avgDaysToOnboard !== null ? `${avgDaysToOnboard}d` : '—'} />
      </div>

      <div className={styles.filterRow}>
        <button
          className={`${styles.chip} ${view === 'tickets' ? styles.chipActive : ''}`}
          onClick={() => setView('tickets')}
        >Onboarding calls ({tickets.length})</button>
        <button
          className={`${styles.chip} ${view === 'lifecycle' ? styles.chipActive : ''}`}
          onClick={() => setView('lifecycle')}
        >All shipped units ({lifecycle.length})</button>
      </div>

      {view === 'tickets' ? (
        <TicketsView tickets={tickets} selectedId={selectedId} onSelect={setSelectedId} />
      ) : (
        <LifecycleView />
      )}

      {selected && <TicketDetailPanel ticket={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function TicketsView({ tickets, selectedId, onSelect }: {
  tickets: ServiceTicket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (tickets.length === 0) return <div className={styles.empty}>No onboarding calls scheduled.</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>Customer</th>
          <th>Unit serial</th>
          <th>Host</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map(t => {
          const s = STATUS_META[t.status];
          return (
            <tr
              key={t.id}
              className={`${styles.row} ${selectedId === t.id ? styles.rowSelected : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <td>{t.calendly_event_start ? new Date(t.calendly_event_start).toLocaleString() : '—'}</td>
              <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{t.unit_serial ?? '—'}</td>
              <td>{t.calendly_host_email ?? '—'}</td>
              <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LifecycleView() {
  const { rows } = useCustomerLifecycle();
  const [busy, setBusy] = useState<string | null>(null);

  async function complete(id: string) {
    setBusy(id);
    try { await markOnboardingComplete(id); } finally { setBusy(null); }
  }
  async function noShow(id: string) {
    setBusy(id);
    try { await markOnboardingNoShow(id); } finally { setBusy(null); }
  }

  if (rows.length === 0) return <div className={styles.empty}>No shipped units yet.</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Shipped</th>
          <th>Unit</th>
          <th>Onboarding</th>
          <th>Warranty</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(l => {
          const w = warrantyState(l);
          return (
            <tr key={l.id}>
              <td>{new Date(l.shipped_at).toLocaleDateString()}</td>
              <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{l.unit_serial}</td>
              <td>{l.onboarding_status}</td>
              <td>
                <span
                  className={`${styles.warrantyPill} ${
                    w.state === 'active'  ? styles.warrantyActive :
                    w.state === 'expired' ? styles.warrantyExpired : styles.warrantyNa
                  }`}
                >
                  {w.state === 'active'  && `${w.daysFromNow}d left`}
                  {w.state === 'expired' && `Expired ${Math.abs(w.daysFromNow)}d ago`}
                  {w.state === 'na'      && 'N/A'}
                </span>
              </td>
              <td>
                {l.onboarding_status !== 'completed' && (
                  <button className={styles.btnGhost} disabled={busy === l.id}
                    onClick={() => void complete(l.id)}>Mark complete</button>
                )}
                {l.onboarding_status === 'scheduled' && (
                  <button className={styles.btnGhost} disabled={busy === l.id}
                    onClick={() => void noShow(l.id)}>No-show</button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 3: Manual verify**

Open `/service`, click Onboarding tab. Lifecycle view should list shipped units (back-filled by Task 1). Try Mark complete on one → status updates in realtime. Roll back any test changes if desired.

- [ ] **Step 4: Commit**

```powershell
git add app/src/modules/Service/OnboardingTab.tsx
git commit -m "feat(service): Onboarding tab — Calendly tickets + lifecycle view`n`nKPI strip (scheduled this week, completed this month, no-shows, avg`nship→onboard days), toggle between Onboarding calls (Calendly tickets)`nand All shipped units (lifecycle rows), Mark complete / No-show actions.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: RepairTab

**Files:**
- Modify: `app/src/modules/Service/RepairTab.tsx`

- [ ] **Step 1: Overwrite RepairTab.tsx**

```typescript
import { useMemo, useState } from 'react';
import { useServiceTickets, STATUS_META, type TicketStatus, type ServiceTicket } from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const STATUS_FILTERS: { key: TicketStatus | 'all'; label: string }[] = [
  { key: 'all',         label: 'All' },
  { key: 'new',         label: 'New' },
  { key: 'triaging',    label: 'Diagnosing' },
  { key: 'in_progress', label: 'In repair' },
  { key: 'waiting_customer', label: 'Waiting parts/customer' },
  { key: 'resolved',    label: 'Resolved' },
];

export function RepairTab() {
  const { tickets, loading } = useServiceTickets('repair');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() =>
    tickets.filter(t => statusFilter === 'all' || t.status === statusFilter),
    [tickets, statusFilter]);
  const selected = tickets.find(t => t.id === selectedId) ?? null;

  // KPIs
  const openCount = tickets.filter(t => t.status !== 'closed' && t.status !== 'resolved').length;
  const inRepairCount = tickets.filter(t => t.status === 'in_progress').length;
  const monthAgo = Date.now() - 30 * 86400_000;
  const resolvedMonthCount = tickets.filter(t =>
    t.status === 'resolved' && t.resolved_at && new Date(t.resolved_at).getTime() > monthAgo
  ).length;

  const avgRepairDays = useMemo(() => {
    const resolved = tickets.filter(t => t.status === 'resolved' && t.resolved_at);
    if (resolved.length === 0) return null;
    const totalDays = resolved.reduce((sum, t) => {
      const days = (new Date(t.resolved_at!).getTime() - new Date(t.created_at).getTime()) / 86400_000;
      return sum + days;
    }, 0);
    return Math.round(totalDays / resolved.length);
  }, [tickets]);

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.kpiStrip}>
        <Kpi label="Open"          value={openCount} />
        <Kpi label="In repair"     value={inRepairCount} />
        <Kpi label="Resolved (30d)" value={resolvedMonthCount} />
        <Kpi label="Avg repair days" value={avgRepairDays !== null ? `${avgRepairDays}d` : '—'} />
      </div>

      <div className={styles.filterRow}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${statusFilter === f.key ? styles.chipActive : ''}`}
            onClick={() => setStatusFilter(f.key)}
          >{f.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No repair tickets match these filters.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Flagged</th>
              <th>Customer</th>
              <th>Unit serial</th>
              <th>Defect</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Days open</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <RepairRow key={t.id} t={t}
                selected={selectedId === t.id}
                onClick={() => setSelectedId(t.id)} />
            ))}
          </tbody>
        </table>
      )}

      {selected && <TicketDetailPanel ticket={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function RepairRow({ t, selected, onClick }: { t: ServiceTicket; selected: boolean; onClick: () => void }) {
  const s = STATUS_META[t.status];
  const daysOpen = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400_000);
  return (
    <tr className={`${styles.row} ${selected ? styles.rowSelected : ''}`} onClick={onClick}>
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{t.unit_serial ?? '—'}</td>
      <td>{t.defect_category ?? '—'}</td>
      <td><span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span></td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
      <td>{daysOpen}</td>
    </tr>
  );
}
```

- [ ] **Step 2: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```powershell
git add app/src/modules/Service/RepairTab.tsx
git commit -m "feat(service): Repair tab`n`nKPI strip (open, in repair, resolved 30d, avg repair days), status filter`nchips with repair-specific labels (Diagnosing / In repair / Waiting parts),`ndays-open column, shared TicketDetailPanel for repair detail with defect`ncategory + parts-needed fields enabled.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Public form `/service-request`

**Files:**
- Create: `app/src/modules/Forms/ServiceRequestForm.tsx`
- Modify: `app/src/App.tsx` (add public route)

- [ ] **Step 1: Write the form**

```typescript
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm';
const MAX_FILE_SIZE = 26214400; // 25 MB
const MAX_FILES = 5;

type FormState = {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  order_ref: string;
  unit_serial: string;
  category: 'support' | 'repair';
  subject: string;
  description: string;
};

const INITIAL: FormState = {
  customer_name: '',
  customer_email: '',
  customer_phone: '',
  order_ref: '',
  unit_serial: '',
  category: 'support',
  subject: '',
  description: '',
};

export default function ServiceRequestForm() {
  const nav = useNavigate();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const valid: File[] = [];
    for (const f of picked) {
      if (f.size > MAX_FILE_SIZE) {
        setError(`${f.name} exceeds 25 MB limit.`);
        continue;
      }
      valid.push(f);
    }
    if (valid.length + files.length > MAX_FILES) {
      setError(`Max ${MAX_FILES} files total.`);
      setFiles(valid.concat(files).slice(0, MAX_FILES));
      return;
    }
    setError(null);
    setFiles(prev => prev.concat(valid).slice(0, MAX_FILES));
  }

  function removeFile(i: number) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (!form.customer_name || !form.customer_email || !form.subject) {
        throw new Error('Name, email, and subject are required.');
      }
      // 1. Insert ticket, return id
      const { data: row, error: insErr } = await supabase
        .from('service_tickets')
        .insert({
          category:       form.category,
          source:         'customer_form',
          customer_name:  form.customer_name,
          customer_email: form.customer_email.toLowerCase(),
          customer_phone: form.customer_phone || null,
          order_ref:      form.order_ref || null,
          unit_serial:    form.unit_serial || null,
          subject:        form.subject,
          description:    form.description || null,
        })
        .select('id')
        .single();
      if (insErr || !row) throw new Error(insErr?.message ?? 'Failed to create ticket');
      const ticketId = row.id as string;

      // 2. Upload each file
      for (const f of files) {
        const path = `${ticketId}/${crypto.randomUUID()}-${f.name}`;
        const { error: upErr } = await supabase.storage
          .from('ticket-attachments')
          .upload(path, f, { contentType: f.type, upsert: false });
        if (upErr) throw new Error(`Upload failed (${f.name}): ${upErr.message}`);

        const { error: attErr } = await supabase
          .from('service_ticket_attachments')
          .insert({
            ticket_id:  ticketId,
            file_path:  path,
            file_name:  f.name,
            mime_type:  f.type,
            size_bytes: f.size,
          });
        if (attErr) throw new Error(`Attachment record failed (${f.name}): ${attErr.message}`);
      }

      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <FormLayout title="Request received">
        <div className={styles.successBlock}>
          <p>Thanks for reaching out. We've received your service request and will get back to you within 1 business day.</p>
          <button className={styles.submitBtn} onClick={() => nav('/return')}>Submit another</button>
        </div>
      </FormLayout>
    );
  }

  return (
    <FormLayout title="Service request">
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.sectionHeader}>Your info</div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Name *</label>
          <input className={styles.input} required value={form.customer_name}
            onChange={e => set('customer_name', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Email *</label>
          <input className={styles.input} type="email" required value={form.customer_email}
            onChange={e => set('customer_email', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Phone</label>
          <input className={styles.input} value={form.customer_phone}
            onChange={e => set('customer_phone', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Order # (if known)</label>
          <input className={styles.input} value={form.order_ref}
            onChange={e => set('order_ref', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Unit serial (if known)</label>
          <input className={styles.input} placeholder="LL01-..." value={form.unit_serial}
            onChange={e => set('unit_serial', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>What can we help with?</div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Request type *</label>
          <div className={styles.radioStack}>
            <label>
              <input type="radio" name="category" checked={form.category === 'support'}
                onChange={() => set('category', 'support')} />
              {' '}General support / question
            </label>
            <label>
              <input type="radio" name="category" checked={form.category === 'repair'}
                onChange={() => set('category', 'repair')} />
              {' '}Repair / hardware issue
            </label>
          </div>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Subject *</label>
          <input className={styles.input} required value={form.subject}
            onChange={e => set('subject', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.label}>Details</label>
          <textarea className={styles.textarea} rows={6} value={form.description}
            onChange={e => set('description', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>Photos / videos (optional)</div>
        <div className={styles.fieldRow}>
          <input type="file" multiple accept={ACCEPT_MIME} onChange={onFiles} />
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            Up to {MAX_FILES} files, 25 MB each. Images (jpg/png/webp/heic) and videos (mp4/mov/webm).
          </div>
          {files.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {files.map((f, i) => (
                <li key={i} style={{ fontSize: 12 }}>
                  {f.name} ({Math.round(f.size / 1000)} KB){' '}
                  <button type="button" onClick={() => removeFile(i)} style={{ color: 'crimson', border: 'none', background: 'none', cursor: 'pointer' }}>remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className={styles.errorBlock}>{error}</div>}

        <button type="submit" className={styles.submitBtn} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </form>
    </FormLayout>
  );
}
```

- [ ] **Step 2: Wire route in App.tsx**

Add to the public-routes section near `<Route path="/return" ...>`:

```typescript
import ServiceRequestForm from './modules/Forms/ServiceRequestForm';
// ...
// Inside <Routes>, alongside /return and /cancel-order:
<Route path="/service-request" element={<ServiceRequestForm />} />
```

- [ ] **Step 3: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 4: Manual verify**

`npm run dev`, open `http://localhost:5173/service-request` (unauthenticated — open in incognito if needed). Fill out the form, attach a small image, submit. Check the Service module's Support tab → new ticket should appear with attachment thumbnail in detail panel.

Roll back the test ticket with SQL if desired:
```sql
delete from public.service_tickets where customer_email='your-test@example.com';
```

- [ ] **Step 5: Commit**

```powershell
git add app/src/modules/Forms/ServiceRequestForm.tsx app/src/App.tsx
git commit -m "feat(service): public /service-request form with multimedia upload`n`nMirrors /return and /cancel-order brand shell. Two-step submit: insert`nticket → upload each file under {ticket_id}/ path in ticket-attachments`nbucket → insert attachment row. Validates 25MB cap and 5-file limit`nclient-side, MIME allow-list enforced by bucket config.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Extend Fulfillment QC flag to create repair tickets

**Files:**
- Modify: `app/src/lib/fulfillment.ts` (extend `flagRework` at line 264; call site is `app/src/modules/Fulfillment/queue/StepTest.tsx:26` — no change needed there)

- [ ] **Step 1: Extend `flagRework`**

The existing function at `app/src/lib/fulfillment.ts:264` currently has this signature:

```typescript
export async function flagRework(
  queueId: string,
  serial: string,
  issue: string,
  flaggedByName: string,
): Promise<void>
```

The current call site (`StepTest.tsx:26`) only has `row.id`, `row.assigned_serial`, `issue`, and `name`. We don't have customer info in scope there. **Simpler path:** have `flagRework` itself create the service_tickets row using only what it already has (queue id, serial, issue) — ops fill in defect category + parts via the Repair detail panel afterwards.

Add the ticket-insert block at the **end** of `flagRework`, right after the `logAction` call at line 291. Keep it idempotent on `fulfillment_queue_id` and non-blocking (the QC flow already succeeded; a ticket insert failure should not throw):

```typescript
  await logAction('fq_test_flagged', queueId, `${serial}: ${issue}`);

  // Also create a service_tickets row so the Service module's Repair
  // tab picks this up. Idempotent on fulfillment_queue_id; if the
  // ticket insert fails we just log — the QC flag already succeeded.
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

Make sure the closing `}` of `flagRework` ends up after the new block.

- [ ] **Step 2: Build**

```powershell
cd app; npm run build; cd ..
```

Expected: build succeeds.

- [ ] **Step 3: Manual verify**

In the Fulfillment module, navigate to a queue row at the QC test step and flag it as failed. Switch to Service → Repair tab. New ticket should appear with:
- `subject = "QC flag: <your issue text>"`
- `source = 'fulfillment_flag'`
- `priority = 'high'`
- `owner_email = 'junaid@virgohome.io'`
- `fulfillment_queue_id` linked to the flagged row

Roll back: undo the QC flag in the Fulfillment UI (or reset via SQL), then:
```sql
delete from public.service_tickets where source='fulfillment_flag' and subject like 'QC flag:%';
```

- [ ] **Step 4: Commit**

```powershell
git add app/src/lib/fulfillment.ts
git commit -m "feat(service): Fulfillment QC flag also creates repair ticket`n`nflagRework now inserts a service_tickets row (source=fulfillment_flag,`npriority=high, owner=Junaid) idempotent on fulfillment_queue_id.`nNon-blocking — if the ticket insert fails the QC flag is still recorded.`n`nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Verification (post-implementation)

After all tasks complete, run a final smoke test:

1. `/service` loads, all 3 tabs render without console errors
2. Onboarding tab's Lifecycle view shows back-filled rows for all shipped units
3. Insert a fake support ticket via SQL → appears in Support tab in realtime → click → detail panel renders → status transition works
4. Submit `/service-request` form anonymously with an image → ticket appears in Support tab with image thumbnail
5. Flag a test unit at Fulfillment QC → repair ticket appears in Repair tab
6. Manually trigger `sync-calendly-events` and `sync-hubspot-tickets` edge functions → no errors if secrets set
7. Verify `cron.job` table has 3 active service-related jobs

Push origin/main → GitHub Pages deploys → re-verify on `lila.vip`.

---

## Deferred items (not in this plan)

These were called out in the spec as Phase 2+:
- Outbound HubSpot sync (resolutions push back to HubSpot)
- HubSpot ticket deprecation
- Parts auto-deduction when repair ticket resolved (ties into Stock module)
- SLA timers + breach alerts
- Customer-facing portal to view their own tickets
- Calendly webhooks (paid tier)
- Configurable warranty terms per product line
