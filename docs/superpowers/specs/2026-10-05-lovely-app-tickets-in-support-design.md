# Lovely app damage reports as support tickets — design

**Date:** 2026-10-05
**Module:** Service › Support Tickets, fed from the Lovely project
**Operator ask:** "Have the Lovely tab's tickets tab be integrated into their
ticket system and have a label saying 'from lovely app' and have all the
information."

## Problem

Customers file damage and missing-item reports from the Lovely app's onboarding
flow. Those reports are rows in the Lovely Supabase project's
`public.damage_reports` (photos in `public.images`, files in the private
`damage-photos` bucket). makelila shows them read-only under Lovely › Tickets
(`modules/Lovely/TicketsTab.tsx`, `lib/lovelyTickets.ts`).

The customer service team does not work from that tab. Their queue is
Service › Support Tickets, backed by `public.service_tickets` in the makelila
project. A damage report therefore has no owner, status, priority, SLA or
notes, and nothing puts it in front of the people who would act on it.

## Decisions already made

- Reports become **real** `service_tickets` rows, not read-only rows merged in
  at display time. CS assigns, statuses, notes and closes them like any other
  ticket.
- **Every existing report is imported as an open ticket**, not only new ones.
- The Lovely › Tickets tab stays as it is.

## What we're building

### 1. Schema (one migration)

`supabase/migrations/<ts>_lovely_app_tickets.sql`

- `service_tickets.lovely_report_id uuid null`, with a unique index where it is
  not null. This is the dedupe key and the link back to the report's photos.
- Extend `service_tickets_source_check` with `'lovely_app'`, using the
  drop-and-re-add pattern from `20260610150000_unit_telemetry_state.sql`. The
  new list must carry every source already in the constraint at that point.
- A pg_cron job `sync-lovely-tickets-15min` on `*/15 * * * *` calling
  `public.invoke_edge_function('sync-lovely-tickets')`, unscheduling any
  existing job of that name first (pattern from
  `20260610150100_cron_telemetry_autoticket.sql`).

### 2. Sync function

`supabase/functions/sync-lovely-tickets/index.ts`, deployed to the **makelila**
project. Modelled on `sync-telemetry-state`:

- Cron-only: `authenticate()` from `_shared/auth.ts`, reject any caller whose
  kind is not `cron`.
- Reads the Lovely project with `TELEMETRY_SUPABASE_URL` /
  `TELEMETRY_SUPABASE_ANON_KEY` (both already set for `sync-telemetry-state`;
  `damage_reports` is anon-readable). No-ops with a 200 when they are missing.
- Writes makelila with the service role.

Per run:

1. Fetch all `damage_reports` (`id, user_id, serial_number, notes, created_at`),
   paginated in pages of 1,000.
2. Fetch the `lovely_report_id`s already present in `service_tickets` and drop
   those reports.
3. For each remaining report, resolve the customer and insert a ticket.
4. Insert an `activity_log` row per created ticket: `user_id` null, type
   `lovely_ticket_created`, `entity_type` `ticket`, `entity_id` the ticket id,
   `unit_serial` the serial.
5. Return `{ created, skipped_existing, unresolved_customer }`.

The insert is insert-only. A unique violation on `lovely_report_id` (two runs
overlapping) is treated as "already synced", not an error. The function never
updates an existing ticket, so edits to a report after sync do not reach the
ticket and nothing CS has changed is overwritten. That matches the
system-of-record rule: Lovely seeds the record, makelila owns it.

The first run after deploy is the backfill. There is no separate backfill path.

**Customer resolution** (same order as `ingest-lovely-event`):

1. Report serial, trimmed and uppercased → `units.serial` → `units.customer_id`.
2. Else report `user_id` → `customer_app_links.lovely_user_id` → `customer_id`.
3. Else no customer. If the app link row has an email, it is still written to
   `customer_email` so CS has a way to reach the person.

When a customer is found, `customer_name` and `customer_email` come from the
makelila `customers` row.

**Ticket fields:**

| Column | Value |
|---|---|
| `source` | `lovely_app` |
| `kind` | `ticket` |
| `category` | `support` |
| `status` | `waiting_on_us` |
| `priority` | `normal` |
| `issue_area` | `shipping` |
| `subject` | `Damage report: <serial>`, or `Damage report from Lovely app` when there is no serial |
| `description` | the report's `notes`; `No notes provided.` when empty |
| `unit_serial` | the report's serial, trimmed and uppercased, when makelila has a unit with that serial; otherwise null (see below) |
| `customer_id` / `customer_name` / `customer_email` | from resolution above |
| `lovely_report_id` | the report id |
| `created_at` | the report's `created_at` |

`service_tickets.unit_serial` is a foreign key to `units(serial)`, so a serial
makelila has no unit for cannot be stored there. In that case `unit_serial` is
left null, the subject still names the serial, and the description gains a
line: `Serial entered in the Lovely app: <serial>. It matched no unit in
makelila, so any unit shown on this ticket was inferred from the customer.`
(The existing `tickets_set_unit_serial` trigger fills a null `unit_serial`
from the customer's most recently shipped unit when a customer is linked.)

The mapping from a report plus its resolved customer to an insert row is a pure
function in its own file beside `index.ts`, so it can be tested without a
database.

### 3. Photos

Photos are not copied. The ticket carries `lovely_report_id`, and the detail
panel loads that report's photos on demand:

- `lib/lovelyTickets.ts` gains `useLovelyReportPhotos(reportId | null)`: reads
  `images` where `damage_report_id = reportId` off the telemetry client, orders
  by `created_at`, signs the paths with the existing `signDamagePhotos`, and
  returns `{ urls, loading, error }`.
- No new secret is needed, photos uploaded after the ticket was created still
  show, and the private bucket keeps its single access path (the
  operator-gated `lovely-damage-photos` function).

### 4. UI

- `lib/service.ts`: add `'lovely_app'` to `TicketSource`, `lovely_app:
  'From Lovely app'` to `SOURCE_LABEL`, and `lovely_report_id: string | null`
  to `ServiceTicket`.
- `Service/SupportTab.tsx`: in the Source cell, render `lovely_app` as a badge
  (new `lovelyAppBadge` class in `Service.module.css`, beside
  `telemetryAutoBadge`). The Source filter is a hard-coded list, so add
  `lovely_app` to both `SOURCE_FILTERS` and the `SourceFilter` type.
- `Service/TicketDetailPanel.tsx`: the header source pill reads "From Lovely
  app" through `sourceLabel`. When `ticket.lovely_report_id` is set, a
  "Lovely app photos" section shows the thumbnails, each opening full size in
  a new tab, with the hook's error shown inline when signing fails.
- `Service/InboxTab.tsx`: no behaviour change; it indexes `SOURCE_LABEL`, which
  now has the key.

## Behaviour to be aware of

- **Backfilled tickets show their real filing date** but get a fresh SLA clock,
  because `tickets_attach_sla()` computes deadlines from `now()` at insert.
  Old reports will not arrive already breached.
- **No customer email is sent on insert.** `tickets_fire_templates()` only
  fires on insert for onboarding/Calendly and repair tickets. Confirm the live
  definition still reads that way before the first run, since that run creates
  a ticket for every historical report.
- **Up to 15 minutes** between a customer filing and the ticket appearing.
- **A report with no matching unit and no app link** lands with no customer and
  sits in the Unassigned group until CS links it.
- **Deleting a synced ticket** frees its `lovely_report_id`, so the next run
  recreates it. CS should close unwanted Lovely tickets rather than delete
  them.

## Out of scope

- Writing anything back to the Lovely project.
- Instant delivery through a webhook from the Lovely project.
- Copying photos into the `ticket-attachments` bucket.
- Changes to the Lovely › Tickets tab, including linking a report to its ticket.

## Testing

- Vitest for the report-to-ticket mapping: subject with and without a serial,
  empty notes, serial normalisation, each customer-resolution branch.
- Vitest for `sourceLabel('lovely_app')`.
- Component tests: SupportTab renders the badge for a `lovely_app` ticket and
  the Source filter narrows to them;
  TicketDetailPanel renders the photos section only when `lovely_report_id` is
  set.
- Manual, after deploy: invoke the function once, check the returned counts
  against the Lovely › Tickets total, invoke it again and confirm `created` is
  0, then open one ticket and confirm its photos load.

## Rollout

1. Apply the migration.
2. Deploy `sync-lovely-tickets` to the makelila project.
3. Ship the frontend.
4. The first cron run performs the backfill.

The frontend can ship before or after the function: unknown sources already
degrade to a humanised label, and the photos section only renders when the new
column is set.
