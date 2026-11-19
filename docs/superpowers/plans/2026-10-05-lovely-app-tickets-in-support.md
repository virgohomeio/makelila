# Lovely App Tickets in Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every damage report a customer files from the Lovely app becomes a real support ticket in Service › Support Tickets, labelled "From Lovely app", carrying the customer, serial, notes, filing date and photos.

**Architecture:** A cron-driven edge function in the makelila project reads `damage_reports` from the Lovely project and inserts one `service_tickets` row per unseen report, keyed by a new unique `lovely_report_id` column. Photos are not copied: the ticket detail panel loads them on demand from the Lovely project through the existing operator-gated signing function. The frontend adds the source label, a badge, a filter option and a photos section.

**Tech Stack:** Supabase (Postgres, pg_cron, Deno edge functions), React 18 + TypeScript, CSS Modules, Vitest + Testing Library, Deno test.

**Spec:** `docs/superpowers/specs/2026-10-05-lovely-app-tickets-in-support-design.md`

## Global Constraints

- Source value is exactly `lovely_app`; its label is exactly `From Lovely app`.
- The sync is **insert-only**. It never updates or deletes an existing `service_tickets` row.
- Nothing is written to the Lovely project. The Lovely client is read-only.
- Ticket defaults: `kind` `ticket`, `category` `support`, `status` `waiting_on_us`, `priority` `normal`, `issue_area` `shipping`.
- Subject is `Damage report: <serial>`, or `Damage report from Lovely app` with no serial. Empty notes become `No notes provided.`
- Components never import `supabase` or `supabaseTelemetry` directly; all data access goes through `app/src/lib/`.
- CSS Modules only, no inline styles beyond what the surrounding code already does.
- The Lovely › Tickets tab (`app/src/modules/Lovely/TicketsTab.tsx`) is not changed.
- **Do not commit, push, apply migrations to the shared database, or deploy functions.** The repo owner does all four. Each task ends by leaving the working tree changed and reporting what changed.
- Two functions directories exist. `supabase/functions/` deploys to makelila; `app/supabase/functions/` deploys to the Lovely project. The new function goes in `supabase/functions/`.

## Review Focus

1. **A report with no serial and no app link.** Expected: a ticket is still created, with no customer and the fallback subject. Pinned in Task 2.
2. **Serial with stray whitespace or lower case** (`" ll01-00000000372 "`). Expected: it still matches the unit and the ticket stores the clean serial. Pinned in Task 2.
3. **Two sync runs overlapping**, so both try to insert the same report. Expected: the second insert hits the unique index and is counted as already synced, not reported as a failure. Pinned in Task 3 (manual check) and by the unique index in Task 1.
4. **A report whose photos fail to sign** (function not deployed, operator signed out). Expected: the ticket panel still renders and shows the error inline in the photos section. Pinned in Task 5.
5. **A ticket that did not come from Lovely.** Expected: no photos section and no request to the Lovely project. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261005120000_lovely_app_tickets.sql` (create) | Column, unique index, source check, cron job |
| `supabase/functions/sync-lovely-tickets/mapReport.ts` (create) | Pure: serial normalisation, customer resolution, report → ticket row |
| `supabase/functions/sync-lovely-tickets/mapReport.test.ts` (create) | Deno tests for the above |
| `supabase/functions/sync-lovely-tickets/index.ts` (create) | Auth, fetch, lookups, insert, activity log |
| `app/src/lib/service.ts` (modify) | `lovely_app` source, label, `lovely_report_id` on the type |
| `app/src/lib/lovelyTickets.ts` (modify) | `orderedPhotoPaths`, `useLovelyReportPhotos` |
| `app/src/modules/Service/LovelyReportPhotos.tsx` (create) | The photos section for one report |
| `app/src/modules/Service/SupportTab.tsx` (modify) | Badge and filter option |
| `app/src/modules/Service/TicketDetailPanel.tsx` (modify) | Mount the photos section |
| `app/src/modules/Service/Service.module.css` (modify) | Badge and thumbnail styles |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261005120000_lovely_app_tickets.sql`

**Interfaces:**
- Produces: column `public.service_tickets.lovely_report_id uuid`; source value `'lovely_app'`; cron job `sync-lovely-tickets-15min` calling edge function `sync-lovely-tickets`.

- [ ] **Step 1: Confirm the current source list**

The check constraint is re-created from a full list, so a source added since `20260610150000_unit_telemetry_state.sql` must not be dropped. Run:

```bash
grep -rn "service_tickets_source_check" -A5 supabase/migrations | grep -v "drop constraint"
```

Expected: the newest definition lists `calendly, customer_form, hubspot, fulfillment_flag, ops_manual, gmail, quo, google_calendar, telemetry_auto`. If a newer migration adds another value, include it in Step 2.

- [ ] **Step 2: Write the migration**

```sql
-- Lovely app damage reports → support tickets.
-- Spec: docs/superpowers/specs/2026-10-05-lovely-app-tickets-in-support-design.md
--
-- sync-lovely-tickets (edge function, cron below) inserts one service_tickets
-- row per row in the Lovely project's damage_reports. lovely_report_id is the
-- dedupe key and the link the detail panel uses to load the report's photos.

-- ============================================================ lovely_report_id

alter table public.service_tickets
  add column if not exists lovely_report_id uuid;

create unique index if not exists idx_tickets_lovely_report_id
  on public.service_tickets (lovely_report_id)
  where lovely_report_id is not null;

comment on column public.service_tickets.lovely_report_id is
  'Lovely project damage_reports.id this ticket was created from (source = lovely_app). Insert-only: the sync never updates the ticket afterwards.';

-- ============================================================ source check (extend)

-- Pattern mirrors 20260610150000_unit_telemetry_state.sql.
alter table public.service_tickets drop constraint if exists service_tickets_source_check;
alter table public.service_tickets add constraint service_tickets_source_check
  check (source = any (array[
    'calendly','customer_form','hubspot','fulfillment_flag',
    'ops_manual','gmail','quo','google_calendar','telemetry_auto',
    'lovely_app'
  ]));

-- ============================================================ sync-lovely-tickets every 15 min

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-lovely-tickets-15min') then
    perform cron.unschedule('sync-lovely-tickets-15min');
  end if;
end $$;

select cron.schedule(
  'sync-lovely-tickets-15min',
  '*/15 * * * *',
  $$ select public.invoke_edge_function('sync-lovely-tickets'); $$
);
```

- [ ] **Step 3: Check it for syntax only**

Do not apply it to the shared database. Read it back once against `20260527220000_cron_sync_quo_tickets.sql` (cron block) and `20260610150000_unit_telemetry_state.sql` lines 118-126 (constraint block) and confirm the shapes match.

- [ ] **Step 4: Report**

State that the migration file exists and is unapplied. No commit.

---

### Task 2: Report → ticket mapping (pure)

**Files:**
- Create: `supabase/functions/sync-lovely-tickets/mapReport.ts`
- Test: `supabase/functions/sync-lovely-tickets/mapReport.test.ts`

**Interfaces:**
- Produces:
  - `type DamageReport = { id: string; user_id: string | null; serial_number: string | null; notes: string | null; created_at: string | null }`
  - `type CustomerLookups = { customerIdBySerial: Map<string, string>; linkByUserId: Map<string, { customer_id: string | null; email: string | null }>; customerById: Map<string, { full_name: string | null; email: string | null }> }`
  - `type ResolvedCustomer = { customer_id: string | null; customer_name: string | null; customer_email: string | null }`
  - `normalizeSerial(raw: string | null | undefined): string | null`
  - `resolveCustomer(report: DamageReport, lookups: CustomerLookups): ResolvedCustomer`
  - `reportToTicket(report: DamageReport, customer: ResolvedCustomer): TicketInsert`

This file must import nothing, so it runs under both Deno and any other runtime.

- [ ] **Step 1: Write the failing tests**

`supabase/functions/sync-lovely-tickets/mapReport.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  normalizeSerial, resolveCustomer, reportToTicket,
  type DamageReport, type CustomerLookups,
} from './mapReport.ts';

const report = (over: Partial<DamageReport> = {}): DamageReport => ({
  id: 'r1', user_id: 'u1', serial_number: 'LL01-00000000372',
  notes: 'Lid cracked', created_at: '2026-09-30T12:00:00Z', ...over,
});

const lookups = (over: Partial<CustomerLookups> = {}): CustomerLookups => ({
  customerIdBySerial: new Map(),
  linkByUserId: new Map(),
  customerById: new Map(),
  ...over,
});

Deno.test('normalizeSerial: trims and uppercases, empty becomes null', () => {
  assertEquals(normalizeSerial(' ll01-00000000372 '), 'LL01-00000000372');
  assertEquals(normalizeSerial('   '), null);
  assertEquals(normalizeSerial(null), null);
});

Deno.test('resolveCustomer: serial match wins over the app link', () => {
  const out = resolveCustomer(report(), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c-serial']]),
    linkByUserId: new Map([['u1', { customer_id: 'c-link', email: 'link@x.com' }]]),
    customerById: new Map([
      ['c-serial', { full_name: 'Sam Serial', email: 'sam@x.com' }],
      ['c-link', { full_name: 'Lee Link', email: 'lee@x.com' }],
    ]),
  }));
  assertEquals(out, { customer_id: 'c-serial', customer_name: 'Sam Serial', customer_email: 'sam@x.com' });
});

Deno.test('resolveCustomer: untidy serial still matches the unit', () => {
  const out = resolveCustomer(report({ serial_number: ' ll01-00000000372 ' }), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c1']]),
    customerById: new Map([['c1', { full_name: 'Sam Serial', email: 'sam@x.com' }]]),
  }));
  assertEquals(out.customer_id, 'c1');
});

Deno.test('resolveCustomer: falls back to the app link when the serial is unknown', () => {
  const out = resolveCustomer(report(), lookups({
    linkByUserId: new Map([['u1', { customer_id: 'c-link', email: 'link@x.com' }]]),
    customerById: new Map([['c-link', { full_name: 'Lee Link', email: 'lee@x.com' }]]),
  }));
  assertEquals(out, { customer_id: 'c-link', customer_name: 'Lee Link', customer_email: 'lee@x.com' });
});

Deno.test('resolveCustomer: unresolved link still yields its email', () => {
  const out = resolveCustomer(report(), lookups({
    linkByUserId: new Map([['u1', { customer_id: null, email: 'link@x.com' }]]),
  }));
  assertEquals(out, { customer_id: null, customer_name: null, customer_email: 'link@x.com' });
});

Deno.test('resolveCustomer: nothing known gives an empty customer', () => {
  const out = resolveCustomer(report({ serial_number: null, user_id: null }), lookups());
  assertEquals(out, { customer_id: null, customer_name: null, customer_email: null });
});

Deno.test('resolveCustomer: blank customer name becomes null', () => {
  const out = resolveCustomer(report(), lookups({
    customerIdBySerial: new Map([['LL01-00000000372', 'c1']]),
    customerById: new Map([['c1', { full_name: '  ', email: 'sam@x.com' }]]),
  }));
  assertEquals(out.customer_name, null);
});

Deno.test('reportToTicket: full report', () => {
  const row = reportToTicket(report({ serial_number: ' ll01-00000000372 ' }), {
    customer_id: 'c1', customer_name: 'Sam Serial', customer_email: 'sam@x.com',
  });
  assertEquals(row, {
    source: 'lovely_app', kind: 'ticket', category: 'support',
    status: 'waiting_on_us', priority: 'normal', issue_area: 'shipping',
    subject: 'Damage report: LL01-00000000372',
    description: 'Lid cracked',
    unit_serial: 'LL01-00000000372',
    customer_id: 'c1', customer_name: 'Sam Serial', customer_email: 'sam@x.com',
    lovely_report_id: 'r1',
    created_at: '2026-09-30T12:00:00Z',
  });
});

Deno.test('reportToTicket: no serial, no notes, no date', () => {
  const row = reportToTicket(
    report({ serial_number: null, notes: '   ', created_at: null }),
    { customer_id: null, customer_name: null, customer_email: null },
  );
  assertEquals(row.subject, 'Damage report from Lovely app');
  assertEquals(row.description, 'No notes provided.');
  assertEquals(row.unit_serial, null);
  // No created_at key at all, so the column default (now()) applies.
  assertEquals('created_at' in row, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno test supabase/functions/sync-lovely-tickets/mapReport.test.ts`
Expected: FAIL, module `./mapReport.ts` not found.

- [ ] **Step 3: Write the implementation**

`supabase/functions/sync-lovely-tickets/mapReport.ts`:

```ts
// Pure mapping from a Lovely damage report to a service_tickets insert row.
// No imports: kept runtime-neutral so it is testable without a database.

export type DamageReport = {
  id: string;
  user_id: string | null;
  serial_number: string | null;
  notes: string | null;
  created_at: string | null;
};

export type CustomerLookups = {
  /** units.serial (normalised) → units.customer_id */
  customerIdBySerial: Map<string, string>;
  /** customer_app_links.lovely_user_id → link */
  linkByUserId: Map<string, { customer_id: string | null; email: string | null }>;
  /** customers.id → display fields */
  customerById: Map<string, { full_name: string | null; email: string | null }>;
};

export type ResolvedCustomer = {
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
};

export type TicketInsert = {
  source: 'lovely_app';
  kind: 'ticket';
  category: 'support';
  status: 'waiting_on_us';
  priority: 'normal';
  issue_area: 'shipping';
  subject: string;
  description: string;
  unit_serial: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  lovely_report_id: string;
  created_at?: string;
};

export function normalizeSerial(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return s || null;
}

// Same order as ingest-lovely-event: the unit's serial is the strongest
// signal, the app account link is the fallback.
export function resolveCustomer(report: DamageReport, lookups: CustomerLookups): ResolvedCustomer {
  const serial = normalizeSerial(report.serial_number);
  const link = report.user_id ? lookups.linkByUserId.get(report.user_id) : undefined;
  const customerId =
    (serial ? lookups.customerIdBySerial.get(serial) : undefined)
    ?? link?.customer_id
    ?? null;

  if (customerId) {
    const c = lookups.customerById.get(customerId);
    return {
      customer_id: customerId,
      customer_name: c?.full_name?.trim() || null,
      customer_email: c?.email ?? link?.email ?? null,
    };
  }
  return { customer_id: null, customer_name: null, customer_email: link?.email ?? null };
}

export function reportToTicket(report: DamageReport, customer: ResolvedCustomer): TicketInsert {
  const serial = normalizeSerial(report.serial_number);
  return {
    source: 'lovely_app',
    kind: 'ticket',
    category: 'support',
    status: 'waiting_on_us',
    priority: 'normal',
    issue_area: 'shipping',
    subject: serial ? `Damage report: ${serial}` : 'Damage report from Lovely app',
    description: report.notes?.trim() || 'No notes provided.',
    unit_serial: serial,
    ...customer,
    lovely_report_id: report.id,
    ...(report.created_at ? { created_at: report.created_at } : {}),
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `deno test supabase/functions/sync-lovely-tickets/mapReport.test.ts`
Expected: 9 passed, 0 failed.

- [ ] **Step 5: Report**

No commit. Report the two new files and the test result.

---

### Task 3: Sync edge function

**Files:**
- Create: `supabase/functions/sync-lovely-tickets/index.ts`

**Interfaces:**
- Consumes from Task 2: `DamageReport`, `CustomerLookups`, `normalizeSerial`, `resolveCustomer`, `reportToTicket` from `./mapReport.ts`.
- Consumes: `authenticate(req, admin)` from `../_shared/auth.ts`, returning `{ kind: 'cron' } | { kind: 'user'; ... }` and throwing a `Response` on failure.
- Produces: HTTP POST handler returning `{ created: number; skipped_existing: number; unresolved_customer: number; failed: number }`, or `{ skipped: true; reason: string }` when the Lovely credentials are not set.

- [ ] **Step 1: Write the function**

```ts
// Sync Lovely app damage reports into makelila support tickets.
//
// Reads public.damage_reports from the Lovely Supabase project and inserts one
// service_tickets row (source = 'lovely_app') per report not yet synced.
// service_tickets.lovely_report_id is the dedupe key. INSERT-ONLY: an existing
// ticket is never updated, so operator edits are never clobbered.
//
// Runs every 15 minutes via pg_cron (sync-lovely-tickets-15min). The first run
// after deploy is the backfill; there is no separate backfill path.
// Gracefully no-ops when the Lovely credentials are not set.
//
// Required env vars:
//   SUPABASE_URL                — write target (makeLILA project)
//   SUPABASE_SERVICE_ROLE_KEY   — service role for makeLILA writes
//   TELEMETRY_SUPABASE_URL      — read source (Lovely project)
//   TELEMETRY_SUPABASE_ANON_KEY — anon key; damage_reports is anon-readable
//
// Auth: cron-only (X-Cron-Secret header required, matching CRON_SHARED_SECRET).
//
// Spec: docs/superpowers/specs/2026-10-05-lovely-app-tickets-in-support-design.md

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';
import {
  normalizeSerial, resolveCustomer, reportToTicket,
  type DamageReport, type CustomerLookups,
} from './mapReport.ts';

// Inline corsHeaders — avoids module-resolution issues at deploy time.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// PostgREST caps a response at max_rows (1000 on hosted Supabase).
const PAGE = 1_000;
// Keeps `.in()` filters well inside URL length limits.
const IN_CHUNK = 200;
const UNIQUE_VIOLATION = '23505';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return jsonResponse({ error: `Uncaught: ${msg}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const lovelyUrl   = Deno.env.get('TELEMETRY_SUPABASE_URL');
  const lovelyKey   = Deno.env.get('TELEMETRY_SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return jsonResponse({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  if (!lovelyUrl || !lovelyKey) {
    return jsonResponse({
      skipped: true,
      reason: 'TELEMETRY_SUPABASE_URL or TELEMETRY_SUPABASE_ANON_KEY not configured — inert until secrets are set',
    }, 200);
  }
  const lovely = createClient(lovelyUrl, lovelyKey);

  // Step 1: every damage report, oldest first so ticket numbers follow filing order.
  const reports: DamageReport[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await lovely
      .from('damage_reports')
      .select('id, user_id, serial_number, notes, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonResponse({ error: `Failed to fetch damage_reports: ${error.message}` }, 500);
    const batch = (data ?? []) as DamageReport[];
    reports.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Step 2: drop the ones already synced.
  const synced = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('service_tickets')
      .select('lovely_report_id')
      .not('lovely_report_id', 'is', null)
      .order('lovely_report_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonResponse({ error: `Failed to read synced reports: ${error.message}` }, 500);
    const batch = (data ?? []) as { lovely_report_id: string }[];
    for (const r of batch) synced.add(r.lovely_report_id);
    if (batch.length < PAGE) break;
  }
  const fresh = reports.filter(r => !synced.has(r.id));
  const skippedExisting = reports.length - fresh.length;
  if (fresh.length === 0) {
    return jsonResponse({ created: 0, skipped_existing: skippedExisting, unresolved_customer: 0, failed: 0 }, 200);
  }

  // Step 3: customer lookups for the fresh reports only.
  let lookups: CustomerLookups;
  try { lookups = await loadLookups(admin, fresh); }
  catch (e) { return jsonResponse({ error: (e as Error).message }, 500); }

  // Step 4: insert one at a time, so a single bad row or a race with an
  // overlapping run costs that report only.
  let created = 0, unresolved = 0, failed = 0, raced = 0;
  for (const report of fresh) {
    const customer = resolveCustomer(report, lookups);
    const { data: ticket, error } = await admin
      .from('service_tickets')
      .insert(reportToTicket(report, customer))
      .select('id, ticket_number, unit_serial')
      .single();

    if (error || !ticket) {
      if (error?.code === UNIQUE_VIOLATION) { raced++; continue; }
      console.error(`sync-lovely-tickets: insert failed for report ${report.id}: ${error?.message}`);
      failed++;
      continue;
    }
    created++;
    if (!customer.customer_id) unresolved++;

    // Audit trail. user_id = null for system-initiated events.
    const { error: logErr } = await admin.from('activity_log').insert({
      user_id: null,
      type: 'lovely_ticket_created',
      entity: ticket.ticket_number,
      detail: `report=${report.id}`,
      entity_type: 'ticket',
      entity_id: ticket.id,
      unit_serial: ticket.unit_serial,
    });
    if (logErr) console.error(`sync-lovely-tickets: activity_log failed for ${ticket.id}: ${logErr.message}`);
  }

  return jsonResponse({
    created,
    skipped_existing: skippedExisting + raced,
    unresolved_customer: unresolved,
    failed,
  }, failed > 0 && created === 0 ? 500 : 200);
}

// Three batched reads: units by serial, app links by Lovely user id, then the
// customers those two point at.
async function loadLookups(admin: SupabaseClient, reports: DamageReport[]): Promise<CustomerLookups> {
  const serials = unique(reports.map(r => normalizeSerial(r.serial_number)));
  const userIds = unique(reports.map(r => r.user_id));

  const customerIdBySerial = new Map<string, string>();
  for (const part of chunks(serials)) {
    const { data, error } = await admin.from('units').select('serial, customer_id').in('serial', part);
    if (error) throw new Error(`Failed to read units: ${error.message}`);
    for (const u of (data ?? []) as { serial: string; customer_id: string | null }[]) {
      const serial = normalizeSerial(u.serial);
      if (serial && u.customer_id) customerIdBySerial.set(serial, u.customer_id);
    }
  }

  const linkByUserId = new Map<string, { customer_id: string | null; email: string | null }>();
  for (const part of chunks(userIds)) {
    const { data, error } = await admin
      .from('customer_app_links').select('lovely_user_id, customer_id, email').in('lovely_user_id', part);
    if (error) throw new Error(`Failed to read customer_app_links: ${error.message}`);
    for (const l of (data ?? []) as { lovely_user_id: string; customer_id: string | null; email: string | null }[]) {
      linkByUserId.set(l.lovely_user_id, { customer_id: l.customer_id, email: l.email });
    }
  }

  const customerIds = unique([
    ...customerIdBySerial.values(),
    ...[...linkByUserId.values()].map(l => l.customer_id),
  ]);
  const customerById = new Map<string, { full_name: string | null; email: string | null }>();
  for (const part of chunks(customerIds)) {
    const { data, error } = await admin.from('customers').select('id, full_name, email').in('id', part);
    if (error) throw new Error(`Failed to read customers: ${error.message}`);
    for (const c of (data ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      customerById.set(c.id, { full_name: c.full_name, email: c.email });
    }
  }

  return { customerIdBySerial, linkByUserId, customerById };
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Type-check it**

Run: `deno check supabase/functions/sync-lovely-tickets/index.ts`
Expected: no errors. If `deno check` cannot resolve `esm.sh` offline, run it once with network access.

- [ ] **Step 3: Re-run the mapping tests**

Run: `deno test supabase/functions/sync-lovely-tickets/mapReport.test.ts`
Expected: 9 passed.

- [ ] **Step 4: Confirm the column names used**

The function reads `units.serial`, `units.customer_id`, `customer_app_links.lovely_user_id / customer_id / email`, `customers.id / full_name / email`, and writes `activity_log.user_id / type / entity / detail / entity_type / entity_id / unit_serial`. Check each against the migrations:

```bash
grep -n "full_name" supabase/migrations/20260420350000_customers_module.sql
grep -n "lovely_user_id\|customer_id\|email" supabase/migrations/20260608010000_customer_events_lovely_integration.sql | head
grep -n "entity_type, entity_id, unit_serial" supabase/migrations/20260610150100_cron_telemetry_autoticket.sql
```

Expected: each grep finds its columns.

- [ ] **Step 5: Report**

No commit, no deploy. Report that the function is written and type-checks, and that it has **not** been run against real data. The post-deploy manual check (owner runs it) is: invoke once and compare `created + skipped_existing` with the Lovely › Tickets total; invoke again and confirm `created` is 0; open one ticket and confirm its photos load.

---

### Task 4: Source label and ticket type

**Files:**
- Modify: `app/src/lib/service.ts:17-19` (`TicketSource`), `:64-134` (`ServiceTicket`), `:280-290` (`SOURCE_LABEL`)
- Test: `app/src/lib/service.test.ts`

**Interfaces:**
- Produces: `TicketSource` includes `'lovely_app'`; `SOURCE_LABEL.lovely_app === 'From Lovely app'`; `ServiceTicket.lovely_report_id?: string | null`.

`lovely_report_id` is optional on the type, like `tags`, because the existing test fixtures build `ServiceTicket` objects field by field and rows cached before the column lands will not carry it.

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/service.test.ts` (add `sourceLabel` to that file's existing import from `./service` if it is not already imported):

```ts
describe('sourceLabel — Lovely app', () => {
  it('labels tickets synced from the Lovely app', () => {
    expect(sourceLabel('lovely_app')).toBe('From Lovely app');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `app/`): `npx vitest run src/lib/service.test.ts -t "Lovely app"`
Expected: FAIL, received `"Lovely App"` (the humanised fallback).

- [ ] **Step 3: Implement**

In `app/src/lib/service.ts`, extend the union:

```ts
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag'
  | 'ops_manual' | 'gmail' | 'quo' | 'google_calendar' | 'telemetry_auto'
  | 'lovely_app';
```

Add to `SOURCE_LABEL`, after `telemetry_auto`:

```ts
  lovely_app:       'From Lovely app',
```

Add to `ServiceTicket`, after `engineering_resolved_at`:

```ts
  /** Lovely project damage_reports.id for source 'lovely_app' tickets; the
   *  detail panel loads the report's photos by it. Optional: absent on rows
   *  read before the column landed. */
  lovely_report_id?: string | null;
```

- [ ] **Step 4: Run to verify it passes, and type-check**

Run (from `app/`): `npx vitest run src/lib/service.test.ts` then `npx tsc -b`
Expected: all pass; no type errors. `SOURCE_LABEL` is a `Record<TicketSource, string>`, so a missing key would fail here.

- [ ] **Step 5: Report**

No commit.

---

### Task 5: Photos for one report

**Files:**
- Modify: `app/src/lib/lovelyTickets.ts`
- Create: `app/src/modules/Service/LovelyReportPhotos.tsx`
- Modify: `app/src/modules/Service/Service.module.css`
- Test: `app/src/lib/lovelyTickets.test.ts`, `app/src/modules/Service/__tests__/LovelyReportPhotos.test.tsx`

**Interfaces:**
- Consumes: existing `signDamagePhotos(paths: string[]): Promise<Record<string, string>>` and `supabaseTelemetry` in `lib/lovelyTickets.ts`.
- Produces:
  - `orderedPhotoPaths(images: { raw_object_path: string | null; created_at: string | null }[]): string[]`
  - `useLovelyReportPhotos(reportId: string | null): { paths: string[]; urls: Record<string, string>; loading: boolean; error: string | null }`
  - `<LovelyReportPhotos reportId={string} />`

- [ ] **Step 1: Write the failing lib test**

Append to `app/src/lib/lovelyTickets.test.ts` and add `orderedPhotoPaths` to its import from `./lovelyTickets`:

```ts
describe('orderedPhotoPaths', () => {
  it('returns paths in upload order and drops rows without a path', () => {
    expect(orderedPhotoPaths([
      { raw_object_path: 'u1/2.jpg', created_at: '2026-09-30T00:00:02Z' },
      { raw_object_path: null,       created_at: '2026-09-30T00:00:00Z' },
      { raw_object_path: 'u1/1.jpg', created_at: '2026-09-30T00:00:01Z' },
    ])).toEqual(['u1/1.jpg', 'u1/2.jpg']);
  });

  it('is empty for no images', () => {
    expect(orderedPhotoPaths([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `app/`): `npx vitest run src/lib/lovelyTickets.test.ts`
Expected: FAIL, `orderedPhotoPaths` is not exported.

- [ ] **Step 3: Implement the lib side**

Append to `app/src/lib/lovelyTickets.ts`:

```ts
export function orderedPhotoPaths(
  images: { raw_object_path: string | null; created_at: string | null }[],
): string[] {
  return images
    .filter(i => i.raw_object_path)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    .map(i => i.raw_object_path!);
}

// Photos for ONE damage report, for the Service ticket detail panel (tickets
// with source 'lovely_app' carry the report id). Photos are never copied into
// makelila: paths are read live and signed on demand, so a photo uploaded
// after the ticket was created still shows.
export function useLovelyReportPhotos(reportId: string | null): {
  paths: string[];
  urls: Record<string, string>;
  loading: boolean;
  error: string | null;
} {
  const [paths, setPaths] = useState<string[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(!!reportId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPaths([]);
    setUrls({});
    setError(null);
    if (!reportId) { setLoading(false); return; }
    if (!supabaseTelemetry) {
      setLoading(false);
      setError('Lovely telemetry not configured.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data, error: imgErr } = await supabaseTelemetry
          .from('images')
          .select('raw_object_path, created_at')
          .eq('damage_report_id', reportId);
        if (imgErr) throw new Error(imgErr.message);
        const found = orderedPhotoPaths(
          (data ?? []) as { raw_object_path: string | null; created_at: string | null }[],
        );
        if (cancelled) return;
        setPaths(found);
        const signed = await signDamagePhotos(found);
        if (!cancelled) setUrls(signed);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reportId]);

  return { paths, urls, loading, error };
}
```

- [ ] **Step 4: Run the lib test**

Run (from `app/`): `npx vitest run src/lib/lovelyTickets.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

`app/src/modules/Service/__tests__/LovelyReportPhotos.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let hookResult = { paths: [] as string[], urls: {} as Record<string, string>, loading: false, error: null as string | null };
vi.mock('../../../lib/lovelyTickets', () => ({
  useLovelyReportPhotos: vi.fn(() => hookResult),
}));

import { LovelyReportPhotos } from '../LovelyReportPhotos';

describe('LovelyReportPhotos', () => {
  it('renders one linked thumbnail per signed photo', () => {
    hookResult = {
      paths: ['u1/1.jpg', 'u1/2.jpg'],
      urls: { 'u1/1.jpg': 'https://x/1', 'u1/2.jpg': 'https://x/2' },
      loading: false, error: null,
    };
    render(<LovelyReportPhotos reportId="r1" />);
    const imgs = screen.getAllByRole('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].closest('a')).toHaveAttribute('href', 'https://x/1');
  });

  it('says so when the report has no photos', () => {
    hookResult = { paths: [], urls: {}, loading: false, error: null };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText('No photos on this report.')).toBeInTheDocument();
  });

  it('shows the error instead of throwing when signing fails', () => {
    hookResult = { paths: ['u1/1.jpg'], urls: {}, loading: false, error: "Couldn't load photos (404): not found" };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText(/Photos unavailable\./)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load photos \(404\)/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a loading line while photos load', () => {
    hookResult = { paths: [], urls: {}, loading: true, error: null };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText('Loading photos…')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run (from `app/`): `npx vitest run src/modules/Service/__tests__/LovelyReportPhotos.test.tsx`
Expected: FAIL, cannot resolve `../LovelyReportPhotos`.

- [ ] **Step 7: Implement the component and styles**

`app/src/modules/Service/LovelyReportPhotos.tsx`:

```tsx
import { useLovelyReportPhotos } from '../../lib/lovelyTickets';
import styles from './Service.module.css';

// Photos a customer attached to a Lovely app damage report. Read live from
// the Lovely project (never copied), so this only mounts for tickets that
// carry a lovely_report_id.
export function LovelyReportPhotos({ reportId }: { reportId: string }) {
  const { paths, urls, loading, error } = useLovelyReportPhotos(reportId);

  if (error) return <div className={styles.muted}>Photos unavailable. {error}</div>;
  if (loading && paths.length === 0) return <div className={styles.muted}>Loading photos…</div>;
  if (paths.length === 0) return <div className={styles.muted}>No photos on this report.</div>;

  return (
    <div className={styles.lovelyPhotos}>
      {paths.map((p, i) => {
        const url = urls[p];
        return url ? (
          <a key={p} href={url} target="_blank" rel="noreferrer" className={styles.lovelyPhoto}>
            <img src={url} alt={`Lovely app photo ${i + 1}`} loading="lazy" />
          </a>
        ) : (
          <div key={p} className={`${styles.lovelyPhoto} ${styles.lovelyPhotoPending}`} />
        );
      })}
    </div>
  );
}
```

Append to `app/src/modules/Service/Service.module.css`, directly after the `.telemetryAutoBadge` rule (around line 1108):

```css
.lovelyAppBadge {
  display: inline-block;
  background: #f0f7ee;
  color: #2f6b3a;
  border: 1px solid #b9dcc0;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.lovelyPhotos { display: flex; gap: 8px; flex-wrap: wrap; }
.lovelyPhoto {
  width: 96px;
  height: 96px;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(44, 42, 37, 0.06);
  display: block;
}
.lovelyPhoto img { width: 100%; height: 100%; object-fit: cover; display: block; }
.lovelyPhotoPending { opacity: 0.6; }
```

- [ ] **Step 8: Run tests and the CSS token check**

Run (from `app/`): `npx vitest run src/modules/Service/__tests__/LovelyReportPhotos.test.tsx` then `npm run check:css-tokens`
Expected: 4 passed. If the token check rejects the raw hex colours in `.lovelyAppBadge`, replace them with the nearest tokens it names (the check prints the offending line and the allowed tokens) and re-run.

- [ ] **Step 9: Report**

No commit.

---

### Task 6: Badge, filter and panel wiring

**Files:**
- Modify: `app/src/modules/Service/SupportTab.tsx:36-45` (filter list and type), `:918-923` (Source cell)
- Modify: `app/src/modules/Service/TicketDetailPanel.tsx:26` (import), `:1003-1006` (mount beside Attachments)
- Test: `app/src/modules/Service/__tests__/SupportTab.test.tsx`, `app/src/modules/Service/__tests__/TicketDetailPanel.test.tsx`

**Interfaces:**
- Consumes from Task 4: `'lovely_app'` in `TicketSource`, `ServiceTicket.lovely_report_id`.
- Consumes from Task 5: `<LovelyReportPhotos reportId={string} />`, CSS class `lovelyAppBadge`.

- [ ] **Step 1: Write the failing SupportTab tests**

Append to `app/src/modules/Service/__tests__/SupportTab.test.tsx`:

```tsx
describe('SupportTab — Lovely app tickets', () => {
  it('badges a ticket synced from the Lovely app', () => {
    ticketsToReturn = [mkTicket({ id: 'lv1', source: 'lovely_app', subject: 'Damage report: LL01-00000000372' })];
    render(<SupportTab />);
    expect(screen.getByText('From Lovely app')).toBeInTheDocument();
  });

  it('narrows the list to Lovely app tickets from the Source filter', () => {
    ticketsToReturn = [
      mkTicket({ id: 'lv2', source: 'lovely_app', subject: 'Damage report: LL01-00000000372' }),
      mkTicket({ id: 'gm1', source: 'gmail', subject: 'email question' }),
    ];
    render(<SupportTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByText('From Lovely app', { selector: '[role="menuitemcheckbox"], [role="menuitem"], button' }));
    expect(screen.queryByText('email question')).toBeNull();
    expect(screen.getAllByText('Damage report: LL01-00000000372').length).toBeGreaterThan(0);
  });
});
```

Before relying on the second test's selectors, open `app/src/modules/Service/SupportTab.tsx` and find the `Dropdown` and `MenuItem` components it uses. Match the test to what they render: the trigger's accessible name and the menu item's role. Another test in this file that opens a dropdown (search for `fireEvent.click(screen.getByRole('button'`) shows the working pattern; copy it.

- [ ] **Step 2: Run to verify they fail**

Run (from `app/`): `npx vitest run src/modules/Service/__tests__/SupportTab.test.tsx -t "Lovely app"`
Expected: the badge test may already pass on the plain label from Task 4; the filter test FAILS because the menu has no "From Lovely app" option.

- [ ] **Step 3: Implement SupportTab**

Replace the filter list and type at lines 36-45:

```tsx
const SOURCE_FILTERS: { key: SourceFilter; label: string }[] = [
  { key: 'all',            label: 'Any source' },
  { key: 'gmail',          label: 'Gmail' },
  { key: 'customer_form',  label: 'Form' },
  { key: 'hubspot',        label: 'HubSpot' },
  { key: 'quo',            label: 'Quo' },
  { key: 'telemetry_auto', label: 'Telemetry auto' },
  { key: 'lovely_app',     label: 'From Lovely app' },
];

type SourceFilter = 'all' | 'customer_form' | 'hubspot' | 'gmail' | 'quo' | 'telemetry_auto' | 'lovely_app';
```

Replace the Source cell at lines 918-923:

```tsx
      <td>
        {t.source === 'telemetry_auto'
          ? <span className={styles.telemetryAutoBadge}>Telemetry auto</span>
          : t.source === 'lovely_app'
            ? <span className={styles.lovelyAppBadge}>From Lovely app</span>
            : sourceLabel(t.source)
        }
      </td>
```

- [ ] **Step 4: Run the SupportTab tests**

Run (from `app/`): `npx vitest run src/modules/Service/__tests__/SupportTab.test.tsx`
Expected: every test in the file passes, including the two new ones.

- [ ] **Step 5: Write the failing panel tests**

In `app/src/modules/Service/__tests__/TicketDetailPanel.test.tsx`, add this mock beside the existing `vi.mock('../AttachmentStrip', ...)` line:

```tsx
vi.mock('../LovelyReportPhotos', () => ({
  LovelyReportPhotos: (p: { reportId: string }) => <div data-testid="lovely-photos">{p.reportId}</div>,
}));
```

Append:

```tsx
describe('TicketDetailPanel — Lovely app tickets', () => {
  it('shows the source label and the report photos', () => {
    render(
      <TicketDetailPanel
        ticket={mkTicket({ source: 'lovely_app', lovely_report_id: 'r-123' })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('From Lovely app')).toBeInTheDocument();
    expect(screen.getByText('Lovely app photos')).toBeInTheDocument();
    expect(screen.getByTestId('lovely-photos')).toHaveTextContent('r-123');
  });

  it('shows no Lovely photos section on other tickets', () => {
    render(<TicketDetailPanel ticket={mkTicket()} onClose={() => {}} />);
    expect(screen.queryByText('Lovely app photos')).toBeNull();
    expect(screen.queryByTestId('lovely-photos')).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run (from `app/`): `npx vitest run src/modules/Service/__tests__/TicketDetailPanel.test.tsx -t "Lovely app"`
Expected: the first test FAILS on `Lovely app photos`; the second passes.

- [ ] **Step 7: Implement the panel**

In `app/src/modules/Service/TicketDetailPanel.tsx`, add beside the `AttachmentStrip` import (line 26):

```tsx
import { LovelyReportPhotos } from './LovelyReportPhotos';
```

Directly above the existing Attachments section (line 1003), add:

```tsx
        {ticket.lovely_report_id && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Lovely app photos</div>
            <LovelyReportPhotos reportId={ticket.lovely_report_id} />
          </div>
        )}

```

The header source pill needs no change: it already calls `sourceLabel(ticket.source)`.

- [ ] **Step 8: Run the whole suite, type-check and lint**

Run (from `app/`): `npx vitest run` then `npx tsc -b` then `npm run lint`
Expected: all tests pass; no type errors; no new lint errors. Report the actual counts.

- [ ] **Step 9: Report**

No commit. Summarise every file created or modified across the plan, the test results, and the three things only the repo owner can do: apply the migration, deploy `sync-lovely-tickets` to the makelila project, and run the post-deploy check from Task 3 Step 5. Remind them of the spec's pre-flight: confirm the live `tickets_fire_templates()` still sends nothing for `category = 'support'` inserts before the first run.
