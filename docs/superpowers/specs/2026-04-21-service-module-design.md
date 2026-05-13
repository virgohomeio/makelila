# Service Module — Design Spec

**Date:** 2026-04-21
**Status:** Approved scope; ready for plan
**Author:** Huayi + Claude (brainstorming session)

---

## Goal

Add a Service module to makelila that consolidates everything that happens to a unit after fulfillment: onboarding calls (Calendly), customer support tickets (form + HubSpot sync), repair tickets (from Fulfillment QC flags), and warranty tracking (computed from ship date).

Replaces scattered tracking in HubSpot, Calendly dashboards, WeChat threads, and Pedrum's spreadsheet.

## Architecture

Two tables: `customer_lifecycle` (one row per shipped unit — warranty + onboarding state) and `service_tickets` (unified table for support/repair/onboarding, distinguished by `category` enum). Tickets accept multimedia attachments via a third table + Supabase Storage bucket. Three intake paths (Calendly poll, public form, HubSpot poll) plus one internal path (Fulfillment QC flag). State machine drives transitions and template auto-fires. UI is 3 tabs (Onboarding/Support/Repair) — warranty is a computed pill on every ticket, not its own tab.

## Tech Stack

- React 19 + TypeScript (existing app)
- Supabase Postgres + RLS + realtime
- Supabase Edge Functions (Deno 2) for Calendly + HubSpot polling
- Supabase Storage for attachments
- pg_cron for periodic syncs
- pg_net + existing `send-template-email` edge function for template auto-fires

---

## Section 1: Schema

### `customer_lifecycle`

One row per shipped unit. Created automatically by trigger when `units.status` transitions to `shipped`.

```sql
CREATE TABLE customer_lifecycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id),
  unit_id uuid NOT NULL REFERENCES units(id) UNIQUE,
  shipped_at timestamptz NOT NULL,
  onboarding_status text NOT NULL DEFAULT 'not_scheduled'
    CHECK (onboarding_status IN ('not_scheduled','scheduled','completed','no_show','skipped')),
  onboarding_completed_at timestamptz,
  warranty_months int NOT NULL DEFAULT 12,
  warranty_expires_at timestamptz GENERATED ALWAYS AS
    (shipped_at + (warranty_months || ' months')::interval) STORED,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON customer_lifecycle(customer_id);
CREATE INDEX ON customer_lifecycle(warranty_expires_at);
```

### `service_tickets`

```sql
CREATE TABLE service_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text NOT NULL UNIQUE,  -- e.g. ST-2026-0001, auto-generated
  category text NOT NULL CHECK (category IN ('onboarding','support','repair')),
  source text NOT NULL CHECK (source IN ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','triaging','in_progress','waiting_customer','resolved','closed','escalated')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),

  -- Customer linkage (denormalized for anonymous-form intake)
  customer_id uuid REFERENCES customers(id),
  customer_name text,
  customer_email text,
  customer_phone text,

  -- Unit linkage
  unit_id uuid REFERENCES units(id),
  unit_serial text,
  order_ref text,

  -- Content
  subject text NOT NULL,
  description text,
  internal_notes text,

  -- Category-specific
  defect_category text,                -- repair only: Door/Auger/Heater/Sensor/Wiring/Other
  parts_needed text,                   -- repair only, free-text for now
  calendly_event_uri text UNIQUE,      -- onboarding only, dedupe key
  calendly_event_start timestamptz,
  calendly_host_email text,
  hubspot_ticket_id text UNIQUE,       -- hubspot sync dedupe key
  fulfillment_queue_id uuid REFERENCES fulfillment_queue(id),

  -- Workflow
  owner_email text,                    -- assigned ops member
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON service_tickets(category, status);
CREATE INDEX ON service_tickets(customer_id);
CREATE INDEX ON service_tickets(unit_id);
CREATE INDEX ON service_tickets(created_at DESC);
```

### `service_ticket_attachments`

```sql
CREATE TABLE service_ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  file_path text NOT NULL,             -- path within ticket-attachments bucket
  file_name text NOT NULL,             -- original filename
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by uuid REFERENCES auth.users(id)  -- null for customer uploads
);
CREATE INDEX ON service_ticket_attachments(ticket_id);
```

### Storage bucket

Bucket `ticket-attachments`:
- Private (signed-URL access for reads)
- Anon INSERT allowed (customer-form path)
- Authenticated SELECT for ops
- File path convention: `{ticket_id}/{uuid}-{filename}`
- Validation enforced in application layer + edge-function intake:
  - Max 25 MB per file
  - Max 5 files per ticket
  - MIME allow-list: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `video/mp4`, `video/quicktime`, `video/webm`

### Ticket number generator

Trigger BEFORE INSERT fills `ticket_number` as `ST-YYYY-NNNN` where NNNN is the per-year sequence (use a `service_ticket_seq_YYYY` sequence created on demand, or a simpler COUNT-based approach gated by advisory lock).

---

## Section 2: Integrations + state machines

### A. Intake sources (4 paths)

**1. Calendly poll → onboarding tickets**
- Edge function `sync-calendly-events` runs hourly via pg_cron
- Fetches `/scheduled_events?min_start_time=now-1h&max_start_time=now+30d`
- Upserts into `service_tickets` with `source='calendly'`, `category='onboarding'`, `calendly_event_uri` as unique dedupe key
- Invitee email → matches `customers` table to attach `customer_id` when found
- Also updates corresponding `customer_lifecycle.onboarding_status` to `scheduled`

**2. Public form `/service-request` → support/repair tickets**
- Anonymous INSERT policy on `service_tickets` + `service_ticket_attachments` (mirrors `/return`, `/cancel-order` pattern)
- Fields: name, email, phone, order_ref, category (support or repair), subject, description, attachments[]
- `source='customer_form'`, `status='new'`
- Customer-facing brand shell (FormLayout component already exists)

**3. HubSpot poll → mixed-category tickets** *(Phase 1: inbound only)*
- Edge function `sync-hubspot-tickets` runs hourly via pg_cron, parallel to `sync-hubspot-customers`
- Fetches `/crm/v3/objects/tickets?properties=subject,content,hs_pipeline_stage,hs_ticket_priority,hs_ticket_category,createdate,hubspot_owner_id`
- Upserts with `source='hubspot'`, `hubspot_ticket_id` (unique) for dedupe
- Mapping:
  - HubSpot `subject` → `subject`
  - HubSpot `content` → `description`
  - HubSpot `hs_ticket_priority` → `priority` (HIGH→high, MEDIUM→normal, LOW→low)
  - HubSpot pipeline stage → `status` (open stages → `new`/`in_progress`, closed → `resolved`)
  - HubSpot `hs_ticket_category` → our `category` if matchable, else `support`
- Email-based customer matching (same as Calendly)
- **Phase 2 (deferred):** outbound — resolutions in makelila PATCH back to HubSpot
- **Phase 3 (deferred):** deprecate HubSpot tickets entirely

**4. Repair flag from Fulfillment QC → repair tickets**
- Extend existing `flagRework` flow in `lib/fulfillment.ts` to also INSERT into `service_tickets`
- `source='fulfillment_flag'`, `category='repair'`, links via `unit_id` + `fulfillment_queue_id`
- Default owner: Junaid

### B. Multimedia attachments

- Customer upload happens client-side in the public form; files go straight to Storage via signed upload URL, then attachment row created
- Ops can also upload via ticket detail panel
- Rendering:
  - `image/*` → thumbnail with click-to-expand modal
  - `video/*` → HTML5 `<video controls>` inline
  - All → download link with original filename
- Attachment strip lives below description in ticket detail panel

### C. Ticket state machine

```
new → triaging → in_progress ⇄ waiting_customer → resolved → closed
                     │
                     └─→ escalated  (manager flag, side state)
```

- `new`: just intaked, no triage yet
- `triaging`: ops assigned, awaiting categorization (or HubSpot import state)
- `in_progress`: actively being worked
- `waiting_customer`: blocked on customer reply
- `resolved`: ops marked done, customer notified
- `closed`: auto-closes 7 days after `resolved` via daily pg_cron job (or manual close)
- `escalated`: optional side state, manager attention required

State changes logged to `activity_log` with previous/next pair.

### D. Lifecycle row auto-creation

DB trigger on `units` AFTER UPDATE when `status` transitions to `shipped`:
```sql
CREATE TRIGGER units_create_lifecycle_on_ship
AFTER UPDATE OF status ON units
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'shipped')
EXECUTE FUNCTION create_lifecycle_row();
```

`create_lifecycle_row()` INSERTs (customer_id, unit_id, shipped_at=now(), warranty_months=12). One row per shipped unit — clean per-unit warranty tracking.

### E. Auto-close stale resolved tickets

Daily pg_cron job: `UPDATE service_tickets SET status='closed', closed_at=now() WHERE status='resolved' AND resolved_at < now() - interval '7 days';`

---

## Section 3: UI

### Route

`/service` registered in `App.tsx`, between `/post-shipment` and `/stock`. Added to `GlobalNav.tsx` MODULES array.

### Module shell

3 tabs: **Onboarding** · **Support** · **Repair**
Warranty is computed, not a tab — surfaced as a pill on every ticket and on the lifecycle sub-view.

### Tab 1: Onboarding

**KPI strip:**
- Scheduled this week
- Completed this month
- No-shows
- Avg days from ship → onboarding

**Sub-views:** Tickets (default) · Lifecycle (admin view of all shipped units + warranty)

**Tickets table columns:** Date/Time · Customer · Unit serial · Calendly host · Status · Actions

**Detail panel (slide-over right):**
- Customer block (name, email, phone)
- Unit serial + ship date + days since shipped
- Calendly event details (start time, host, meeting link)
- Internal notes textarea
- Action buttons: Mark completed · Mark no-show · Reschedule (deep-link to Calendly)
- Recent email sends (filtered to this customer's email)

### Tab 2: Support

**KPI strip:**
- New (24h)
- In progress
- Waiting customer
- Resolved (7d)
- Avg time-to-first-response

**Filter chips:** All · New · Triaging · In progress · Waiting customer · Resolved · (Source: Form / HubSpot)

**Search:** by name, email, ticket #, subject

**Table columns:** # · Created · Customer · Subject · Source · Priority · Status · Owner · Warranty · Actions

**Detail panel:**
- Header: ticket # + status pill + source badge + warranty pill (Active / Expired / N/A)
- Customer block
- Subject + description (rendered)
- **Attachments strip** (images + videos + download links)
- Status transition buttons (state-machine-aware — only valid next states shown)
- Owner dropdown (ops team emails)
- Internal notes timeline
- Send template → opens Templates module pre-filtered to support templates, customer pre-filled
- HubSpot link (if `source='hubspot'`)

### Tab 3: Repair

**KPI strip:**
- Open
- In repair
- Parts ordered
- Resolved (30d)
- Avg repair days

**Filter chips:** All · New · Diagnosing · In repair · Awaiting parts · Resolved

**Table columns:** # · Flagged · Customer · Unit serial · Defect category · Status · Owner · Days open · Actions

**Detail panel:** same shell as Support, plus:
- Unit serial + photo (if attached)
- Defect category dropdown (Door/Auger/Heater/Sensor/Wiring/Other)
- Parts needed textarea
- Link to original Fulfillment QC flag (if `fulfillment_queue_id` set)
- Default owner: Junaid

### Warranty pill (computed)

Shown on every ticket detail + every lifecycle row:
- **Active** (green) — days remaining
- **Expired** (gray) — days since expiry
- **N/A** (faint) — no unit linked

Computed: `unit.shipped_at + interval '12 months' >= now()`

---

## Section 4: Template wiring

Of the 18 templates in `email_templates`, these are wired to Service module triggers. Three new templates added (brings total to 21).

| Trigger | Template key | Behavior |
|---|---|---|
| Lifecycle row created (unit shipped) | `onboarding_welcome` | **Auto-fire** |
| Onboarding ticket created (Calendly) | `onboarding_calendly_confirmation` *(new)* | **Auto-fire** |
| Onboarding ticket → `resolved` | `onboarding_followup_check_in` *(new)* | Suggested |
| Support ticket → `triaging` (first response) | `support_received` | **Auto-fire** |
| Support ticket → `waiting_customer` | `support_need_more_info` | Suggested |
| Support ticket → `resolved` | `support_resolved` | Suggested |
| Repair ticket created | `repair_acknowledged` | **Auto-fire** |
| Repair ticket → `resolved` | `repair_completed` | Suggested |
| Warranty expired on incoming ticket | `warranty_expired_quote` *(new)* | Suggested |

**Mechanism:** DB trigger on `service_tickets` AFTER INSERT/UPDATE OF status fires `pg_net.http_post` to `send-template-email` edge function with `template_key` + variables. Mirrors how Returns/Cancellations wire up.

**New templates to seed:**
- `onboarding_calendly_confirmation` — confirms scheduled time, includes Calendly link
- `onboarding_followup_check_in` — sent after onboarding marked complete, asks how things are going
- `warranty_expired_quote` — politely informs customer warranty has lapsed and offers paid repair quote

---

## Section 5: Open questions / assumptions locked in

**Locked assumptions:**
- Warranty defaults to **12 months** (lilacomposter.com policy not publicly published; verified via WebFetch). Configurable per-unit via `warranty_months` column.
- HubSpot sync is **inbound-only Phase 1**; outbound + deprecation deferred to future iterations.
- Public form lives at `/service-request` (parallel to existing `/return`, `/cancel-order`).
- Repair tickets inherit from existing Fulfillment QC flag flow — minimal new UX for ops.
- Calendly free tier — periodic poll instead of webhooks.
- Attachment limits: 25 MB per file, 5 files per ticket, images + mp4/mov/webm only.
- Junaid is default owner for repair tickets; George for support escalations.
- Lifecycle row is **per unit** (not per customer) — clean for warranty + multi-unit households.
- Ticket number format: `ST-YYYY-NNNN`.
- Auto-close: 7 days after `resolved`.

**Deferred to later iteration:**
- Outbound HubSpot sync (Phase 2)
- HubSpot deprecation (Phase 3)
- Parts auto-deduction when repair ticket resolved (ties to Stock module's Parts & Consumables sub-tab)
- SLA timers + breach alerts
- Customer-facing portal to view their own tickets
- Calendly webhooks (paid tier required)
- Configurable warranty terms per product line

**Confirmed scope:** Onboarding + Support + Repair + Warranty (Scope D from brainstorming).

---

## Files to create / modify

**Migrations:**
- `supabase/migrations/<ts>_service_module_schema.sql` — customer_lifecycle, service_tickets, service_ticket_attachments tables + triggers
- `supabase/migrations/<ts>_service_storage_bucket.sql` — ticket-attachments bucket + policies
- `supabase/migrations/<ts>_service_templates.sql` — 3 new email_templates rows
- `supabase/migrations/<ts>_service_pg_cron.sql` — cron schedules for Calendly + HubSpot + auto-close

**Edge functions:**
- `supabase/functions/sync-calendly-events/index.ts`
- `supabase/functions/sync-hubspot-tickets/index.ts`

**App code:**
- `app/src/lib/service.ts` — types, hooks, mutations
- `app/src/modules/Service/index.tsx` — module shell + tab routing
- `app/src/modules/Service/OnboardingTab.tsx`
- `app/src/modules/Service/SupportTab.tsx`
- `app/src/modules/Service/RepairTab.tsx`
- `app/src/modules/Service/TicketDetailPanel.tsx` — shared detail panel
- `app/src/modules/Service/AttachmentStrip.tsx` — image/video rendering
- `app/src/modules/Service/Service.module.css`
- `app/src/modules/Forms/ServiceRequestForm.tsx` — public form
- `app/src/App.tsx` — `/service` route + `/service-request` route
- `app/src/components/GlobalNav.tsx` — add Service module
- `app/src/lib/fulfillment.ts` — extend `flagRework` to also insert into service_tickets
