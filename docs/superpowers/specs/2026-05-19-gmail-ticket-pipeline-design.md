# Gmail Ticket Pipeline — Design

**Status:** approved (schema shape + phasing)
**Owner:** Reina, with implementation by Claude
**Driver:** replace manual Gmail triage of Quo SMS forwards and direct support emails

## Outcome

A customer sends an SMS to the Quo number or emails support. Within ~5 minutes a row appears in the existing Support Tickets view (and a new "Tickets" admin page that pivots on Gmail-sourced data) with: customer name/phone, auto-generated summary, classified priority and category, suggested next action, deep link back to the Gmail thread. New messages in the thread update the ticket. Staff replies sent from Gmail flip status to `awaiting_customer`.

## Stack adaptation (from brief → actual)

The brief assumed Next.js / Vercel Cron / Drizzle / Tailwind / `/admin/*`. None of those exist here. We adapt to the actual stack:

| Brief assumption | Implementation in this repo |
|---|---|
| Next.js App Router route handlers | Supabase edge functions (`supabase/functions/<name>/index.ts`, Deno) |
| Vercel Cron | `pg_cron` invoking edge function via `pg_net.http_post` ([pattern: `20260512130000_service_pg_cron.sql`](../../supabase/migrations/20260512130000_service_pg_cron.sql)) |
| Drizzle / Prisma | Raw SQL migrations in `supabase/migrations/` |
| Tailwind | CSS Modules per module (`Service.module.css` etc.) |
| `/admin/tickets` route | `/tickets` mounted in `app/src/App.tsx` like the other modules; sidebar entry in `GlobalNav` |
| Staff role / org check | RLS policies already gate all `service_*` tables on `authenticated` |

## Schema decision: extend `service_tickets`, don't fork

The brief specified a new `tickets` table. We're extending the existing [`service_tickets`](../../supabase/migrations/20260512100000_service_module_schema.sql) instead, because:

- It already has `customer_id/name/email/phone`, `subject`, `description`, `priority`, `status`, `category`, `source`, `owner_email`, `hubspot_ticket_id`, `created_at/updated_at`.
- The existing Support Tickets tab filters on `category='support'`. A parallel `tickets` table would split data across two admin UIs for months until HubSpot/Calendly/manual sources migrate.
- Single source of truth. The new admin page is just a different filter/view over the same table.

### Migration: additive only

```sql
-- Extend source enum
alter table service_tickets
  drop constraint service_tickets_source_check,
  add constraint service_tickets_source_check
    check (source in ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual','gmail'));

-- Gmail anchors + auto-classification + auto-message-tracking fields
alter table service_tickets
  add column gmail_thread_id            text unique,
  add column gmail_account              text,
  add column summary                    text,
  add column suggested_next_action      text,
  add column last_classified_at         timestamptz,
  add column classification_confidence  numeric,
  add column message_count              integer not null default 0,
  add column first_message_at           timestamptz,
  add column last_message_at            timestamptz,
  add column is_manually_overridden     boolean not null default false;

create index idx_tickets_last_message on service_tickets (last_message_at desc nulls last);
create index idx_tickets_status_priority on service_tickets (status, priority, last_message_at desc);
```

Three new tables:

- `ticket_messages` — one row per Gmail message; FK to `service_tickets.id`; unique on `gmail_message_id`.
- `ticket_classification_log` — audit trail; one row per classifier invocation; method=`rules`|`llm`; snapshots priority/category; FK to ticket.
- `gmail_sync_state` — one row per mailbox; tracks `last_history_id` for Gmail incremental sync; falls back to date-bounded query when null.

RLS on all three: `authenticated` can read/write, matching existing pattern.

## Phasing (3 PRs)

### PR1 — Data flow (mergeable without UI changes)

- **Migration:** the schema above + the 3 new tables.
- **Edge function `sync-gmail-tickets`:** lists threads via service-account-delegated Gmail API for each mailbox in `GMAIL_DELEGATED_MAILBOXES`; upserts into `service_tickets` keyed on `gmail_thread_id`; upserts `ticket_messages` keyed on `gmail_message_id`; parses Quo subject lines (`New text message from {name} {phone}`, `Missed call from {name}`, `from (XXX) XXX-XXXX`); applies `makelila/synced` Gmail label (best-effort); writes `last_history_id` to `gmail_sync_state`. Exponential backoff on 429/5xx.
- **pg_cron job:** every 5 minutes, calls `invoke_edge_function('sync-gmail-tickets', '{}')`.
- **Phone normalization:** add `libphonenumber-js` to deps if not present (edge function only uses a small inline normalizer since Deno can't use it directly — final decision in PR1 commit).
- **Runbook:** `docs/gmail-sync-setup.md` documents Workspace admin steps (service account, domain-wide delegation, scopes `gmail.readonly` + `gmail.modify`).
- **Existing Support Tickets tab inherits gmail tickets automatically** because they get `category='support'` from the classifier in PR2 (or `category='other'`/null until PR2 lands — those rows render with `—` placeholders in the existing tab without crashing).

### PR2 — Classifier + reclassify

- **`supabase/functions/_shared/classifier/`** module (Deno-compatible TS): pure `classify(thread)` returning `{ priority, category, subject, summary, suggested_next_action, method, ruleId? }`. Rules from the brief, in order. Categories: `return_hardware_defect, warranty_replacement, refund, software_firmware, complaint, callback, assembly_support, troubleshooting, logistics_pickup, order_fulfillment, in_person_service, appointment, marketing_social, closed_acknowledgment, other`.
- **Vitest unit tests** in `app/src/lib/__tests__/classifier.test.ts` — imports a copy of the same logic (CSS-Modules-only frontend can't import from `supabase/functions/`; we'll duplicate the rules array and add a `npm run test:classifier-sync-check` script that diffs the two files to prevent drift).
- **Sync job integration:** after upserting a thread in PR1's sync function, if `last_message_at > last_classified_at OR last_classified_at IS NULL`, run classifier and update ticket (only fields where `is_manually_overridden = false`). Write `ticket_classification_log` row.
- **Endpoint `reclassify-ticket`:** edge function `POST /functions/v1/reclassify-ticket` with `{ ticket_id }`, requires auth header. Forces classifier rerun; writes log row; resets `is_manually_overridden=false`.
- **Manual override:** when a staff member edits priority/category in the UI (PR3) or via the existing TicketDetailPanel pickers, set `is_manually_overridden=true`. The classifier never overwrites manually-edited fields.

### PR3 — Admin Tickets page + LLM + Slack

- **New SPA module `app/src/modules/Tickets/`** mirroring `Service/` structure: index.tsx + tabs/components + Tickets.module.css.
- **List view** at `/tickets`: header with priority count chips and "Sync now" button, filter bar (status / category / assignee / search), sortable table (Priority, Customer, Subject + Summary, Category, Suggested Next Action, Age with stale ⚠ indicator, Assignee, Gmail link ↗). Reuses existing realtime subscription pattern from `useServiceTickets`.
- **Detail page** `/tickets/:id`: full message thread (from `ticket_messages`), classification history (from `ticket_classification_log`), assignee picker, status dropdown, "Reclassify" button.
- **LLM fallback:** Anthropic SDK (Haiku 4.5, `claude-haiku-4-5-20251001`) called from the sync function ONLY when no rule fires. Hard cap 20 calls/run. Cache key = `sha256(thread_id + last_message_id)` stored on the classification log row. Past the cap → fall back to `priority='medium', category='other'` and retry next run.
- **Slack notify (feature flag):** on `priority=urgent` (new or transition), POST to `SLACK_TICKET_WEBHOOK_URL` if set. If unset, no-op with a structured log line. No new Slack auth — webhook URL is the entire setup.
- **Anthropic + Slack are both first-uses in this repo** — secrets added to Supabase project env (`ANTHROPIC_API_KEY`, `SLACK_TICKET_WEBHOOK_URL`).

## Env vars / secrets

| Name | Where | Provided by |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Supabase edge function secrets, base64-encoded JSON | Workspace admin during setup |
| `GMAIL_DELEGATED_MAILBOXES` | Supabase secret, comma-separated | Set during PR1 deploy |
| `SUPABASE_ANON_KEY` (already exists) | pg_cron uses this in `Authorization` header | n/a |
| `SUPABASE_SERVICE_ROLE_KEY` (already exists) | Edge function uses for DB writes | n/a |
| `ANTHROPIC_API_KEY` | Supabase secret | Added in PR3 |
| `SLACK_TICKET_WEBHOOK_URL` | Supabase secret, optional | Added in PR3 |

## Acceptance criteria (from brief, mapped to phases)

- PR1: sync populates `service_tickets` + `ticket_messages` with no duplicates on re-run; new customer message updates `last_message_at` and `message_count`; runbook exists.
- PR2: classifier unit tests pass on all 5 fixtures from the brief; reclassify endpoint writes log row; manual override flag prevents stomping.
- PR3: `/tickets` renders filterable/sortable list with working Gmail links; detail page shows thread + classification history; "Reclassify" works; Slack and LLM live behind their respective env vars.

## Out of scope / intentional TODOs

- Sending replies to customers (read-only on customer side; Reina still replies via Gmail).
- Auto-resolve based on sentiment (only the `closed-ack` rule may auto-resolve, and only when an outbound reply already exists).
- Migrating HubSpot/Calendly tickets into the new admin page format (the existing Support Tickets tab continues to serve them; the new page filters on `source='gmail'` initially).
- Monorepo / shared package for classifier code (we accept the duplication-with-diff-check trade-off for now).

## Risks

- **Gmail historyId expiry.** Google deletes history >7 days old. If sync stalls >7d, we must fall back to date-bounded query. The `gmail_sync_state` schema accommodates this with `last_history_id` nullable.
- **Quo subject parsing brittleness.** If Quo ever changes its forwarding format, name/phone extraction breaks. Mitigated by storing the raw subject + `body_text` in `ticket_messages` so re-parsing is possible after a fix.
- **Classifier drift between Vitest copy and edge function copy.** Mitigated by the diff-check script in PR2. If this becomes painful we revisit (Deno-importable shared package, or run classifier only in edge function and test it with `deno test`).
- **LLM cost.** Capped at 20 calls/run × 12 runs/hr × 24h × 30d = 8.6k calls/mo upper bound. At Haiku 4.5 pricing this is well under $100/mo even at worst case. No alerting needed for v1.
