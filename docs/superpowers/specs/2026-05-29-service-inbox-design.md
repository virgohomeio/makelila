# Service Inbox: Conversations vs. Tickets — Design Spec

**Date:** 2026-05-29
**Author:** Huayi Gao (with Claude)
**Status:** Draft for review

---

## 1. Problem

The Service module's tickets tab currently treats every Quo (OpenPhone) conversation and Gmail thread as a service ticket. This produces three observed failures:

1. **Duplicates.** Sandra Sweet's one Quo conversation has **43 ticket rows** in `service_tickets`. Root cause: `sync-quo-tickets/index.ts:287` uses `.maybeSingle()` to look up the existing ticket by `quo_conversation_id`. When 2+ rows already exist (no DB-level uniqueness backs the assumption), `.maybeSingle()` returns null + error, and the code falls through to a fresh `insert`. Each 5-minute cron run adds another row.
2. **No useful source signal.** The `source` column renders as `"quo"` / `"gmail"` / `"hubspot"` / `"calendly"`. That tells operators which integration ingested the row, but not whether it's a real service issue, a sales inquiry, an onboarding question, or a third-party SDR cold call (e.g. Zendesk Suite sales outreach).
3. **Phone calls and emails are not all tickets.** Customer Service handles sales, onboarding follow-ups, and general check-ins on the same Lila Pro Service line and the same `support@virgohome.io` mailbox. Auto-converting every conversation into a ticket pollutes the Tickets queue and forces operators to triage spam, sales, and follow-up alongside real issues.

## 2. Goal

Separate **conversations** (raw inbound traffic from shared service channels) from **tickets** (operator-confirmed service issues). Give operators a triage Inbox where they decide which conversations become tickets, which are sales leads, which need follow-up, and which are spam.

## 3. Decisions (locked in during brainstorming)

| Decision | Choice |
|----------|--------|
| Conversation/ticket relationship | **Promote-to-ticket.** Conversations land in an Inbox; operators promote real issues. |
| Sources in scope | **Quo + Gmail (`support@virgohome.io` only).** Personal mailboxes excluded. |
| UI placement | **New "Inbox" tab** in the Service module: `Inbox \| Tickets \| Onboarding \| Repair`. |
| Existing data | **Bulk-demote** all current Quo + Gmail rows to `kind='conversation'`. Operators re-triage. HubSpot / Calendly / Customer-form / ops_manual rows stay as tickets. |
| Data model | **Single table** (`service_tickets`) with a `kind` column. Not a two-table split. |

## 4. Architecture

### 4.1 Data model

Add two columns to `service_tickets`:

```sql
alter table public.service_tickets
  add column if not exists kind text not null default 'ticket'
    check (kind in ('conversation', 'ticket')),
  add column if not exists inbox_disposition text
    check (inbox_disposition in ('promoted', 'sales', 'follow_up', 'dismissed'));
```

- `kind = 'conversation'` — row lives in the Inbox tab; hidden from Tickets.
- `kind = 'ticket'` — row lives in the Tickets tab (today's behavior). Default for backward compatibility.
- `inbox_disposition` — operator's triage call. `null` means untriaged (still showing in Inbox's default view).
  - `promoted` → operator clicked "→ Ticket"; row was flipped to `kind='ticket'`. Disposition is preserved for audit.
  - `sales` → kept as a conversation, surfaced under the Inbox's "Sales" filter.
  - `follow_up` → kept as a conversation, surfaced in the Customers module's follow-up calendar (walkthrough #40).
  - `dismissed` → spam/SDR/wrong-number; hidden by default, recoverable via "Show dismissed" toggle.

Add indexes:

```sql
create unique index if not exists service_tickets_quo_conv_uniq
  on public.service_tickets (quo_conversation_id)
  where source = 'quo' and quo_conversation_id is not null;

-- gmail_thread_id partial unique index already exists from 20260519120000.

create index if not exists service_tickets_kind_idx
  on public.service_tickets (kind, last_message_at desc nulls last);
```

`ticket_messages` is unchanged. Promoting a conversation does not move messages; only `kind` flips.

### 4.2 Inbox tab (UI)

Route: same Service module, new top-level tab `Inbox`.

**Columns:**

| Column | Source |
|--------|--------|
| Channel | 📞 (Quo) or ✉️ (Gmail) from `source` |
| Customer | `customer_name` if matched; else "Unknown" + phone/email |
| Last message | `description` snippet (first 80 chars) |
| Age | Now − `last_message_at` |
| Match hint | "Linked to <customer>" if `customer_id` set, else "No match" |
| Disposition | null (untriaged) / Sales / Follow-up / Dismissed |

**Filter bar:** All / **Untriaged** (default) / Sales / Follow-up / Dismissed.

(No "Promoted" filter on the Inbox — promotion flips `kind` to `ticket`, so promoted rows are no longer in the Inbox view. They live in Tickets. If operators later want a "promoted-from-inbox" sub-filter on the Tickets tab, see §7 out of scope.)

**Sort:** `last_message_at` desc, untriaged first.

**Per-row actions:**

- **→ Ticket** — opens Promote modal (see 4.3). On submit: `kind='ticket'`, `inbox_disposition='promoted'`, `category=<chosen>`, row removed from Inbox's default view.
- **Sales** — `inbox_disposition='sales'`, stays in Inbox under the Sales filter.
- **Follow-up** — `inbox_disposition='follow_up'`, surfaces in Customers follow-up calendar (depends on customer linkage; if no `customer_id`, only visible in Inbox's Follow-up filter).
- **Dismiss** — `inbox_disposition='dismissed'`, hidden by default.

Operators can re-triage a row by clicking the disposition pill, which opens a small popover with the four options + "Clear" (back to untriaged).

### 4.3 Promote-to-ticket modal

Opens when the operator clicks **→ Ticket**.

**Fields:**

- **Category** (required) — `support` / `onboarding` / `repair` (matches the existing check constraint on `service_tickets.category` from migration `20260512100000_service_module_schema.sql`).
- **Owner** — defaults to current user's `@virgohome.io` email; dropdown to override.
- **Customer match** — if `customer_id` already set on the conversation, show the matched customer. If not set but a likely match exists (phone or email collision), show a suggestion. "Override" opens the customer picker.

**Submit action (single transaction):**

```ts
await supabase.from('service_tickets').update({
  kind: 'ticket',
  inbox_disposition: 'promoted',
  category,
  owner_email,
  customer_id: customer_id ?? null,
  status: 'open',         // tickets start as open
}).eq('id', conversationId);
await logAction(...);     // existing audit pattern
```

No new tables. No row move.

### 4.4 Filter the Tickets tab to `kind='ticket'`

[`app/src/modules/Service/SupportTab.tsx`](app/src/modules/Service/SupportTab.tsx) currently selects all `service_tickets` rows. Add a hook-level filter so it queries `kind='ticket'`. Verify this single change cleanly removes conversations from view; no other Service consumers should need changes (Onboarding/Repair tabs already filter by `category`).

## 5. Migration (one-shot, ships with the deploy)

Single SQL migration: `supabase/migrations/<timestamp>_service_inbox.sql`.

```sql
-- 1. Schema additions.
alter table public.service_tickets
  add column if not exists kind text not null default 'ticket'
    check (kind in ('conversation', 'ticket')),
  add column if not exists inbox_disposition text
    check (inbox_disposition in ('promoted', 'sales', 'follow_up', 'dismissed'));

-- 2. Dedupe existing Quo rows BEFORE applying the unique index (else the
--    index creation fails). Keep the oldest row per conversation; delete dupes.
delete from public.service_tickets t
  using (
    select quo_conversation_id, min(created_at) as keep_created_at
      from public.service_tickets
      where source = 'quo' and quo_conversation_id is not null
      group by quo_conversation_id
      having count(*) > 1
  ) k
  where t.source = 'quo'
    and t.quo_conversation_id = k.quo_conversation_id
    and t.created_at > k.keep_created_at;

-- 3. Add the unique index now that dupes are gone.
create unique index if not exists service_tickets_quo_conv_uniq
  on public.service_tickets (quo_conversation_id)
  where source = 'quo' and quo_conversation_id is not null;

create index if not exists service_tickets_kind_idx
  on public.service_tickets (kind, last_message_at desc nulls last);

-- 4. Bulk-demote all auto-imported Quo + Gmail rows to inbox conversations.
update public.service_tickets
  set kind = 'conversation'
  where source in ('quo', 'gmail');
```

**Rollback:** `update service_tickets set kind='ticket' where kind='conversation'` + drop the two columns. The dedupe step is destructive (deleted rows are gone) but those rows were duplicates of an existing one — the conversation history they referred to is preserved on the surviving row.

## 6. Sync code changes

### 6.1 `sync-quo-tickets/index.ts` — use upsert

Replace the `select .maybeSingle() + branch insert/update` pattern at lines 287–351 with a single `upsert` keyed on `quo_conversation_id`:

```ts
const { data: existing } = await admin
  .from('service_tickets')
  .upsert(ticketRow, { onConflict: 'quo_conversation_id', ignoreDuplicates: false })
  .select('id, quo_last_message_id, message_count')
  .single();
```

The DB unique index now enforces what the app code intended. `ignoreDuplicates: false` means: if a row exists, return it; if not, insert. The "append messages only" path then uses the returned `quo_last_message_id` to filter new messages.

New conversations from cron land with `kind='conversation'` (the column default) — operators triage them from the Inbox.

### 6.2 `sync-gmail-tickets` — already idempotent, change scope only

The Gmail sync already has `gmail_thread_id` partial unique index from migration `20260519120000`, so the upsert path there is safe. The only change is configuration:

```bash
supabase secrets set GMAIL_DELEGATED_MAILBOXES=support@virgohome.io --project-ref txeftbbzeflequvrmjjr
```

Any other mailboxes that were in this list (huayi@, etc.) come out. Now the only Gmail traffic reaching the Service module is `support@virgohome.io`'s shared inbox.

If `support@virgohome.io` does not exist as a Google Workspace mailbox yet, set it up first (or alias → forward to huayi@ and switch the filter to recipient-based — flag if needed).

## 7. Out of scope (deferred)

- **Outbound replies from the Inbox.** Tracked separately as backlog #12.
- **Smart auto-promote** (e.g., if known customer + message contains "broken"/"refund"/"warranty"). Phase 2 once we have actual triage data.
- **HubSpot / Calendly / Customer-form rows.** These continue as tickets; this design only touches the noisy auto-sourced channels.
- **Two-table refactor.** Sticking with single table + `kind`. Re-evaluate if `service_tickets` grows unwieldy.
- **"Promoted-from-inbox" filter on the Tickets tab.** `inbox_disposition='promoted'` is preserved on tickets that were promoted (vs. tickets created directly), so a future filter is easy to add — not building it now until operators ask.

## 8. Testing strategy

**Unit (Vitest):**
- `lib/service.ts` — `useInbox` returns only `kind='conversation'` rows; `useTickets` returns only `kind='ticket'` rows.
- Inbox filter logic — disposition filters apply correctly; "Untriaged" shows null-disposition rows.

**Migration (manual on a staging branch):**
- Apply migration on a Supabase branch with a copy of prod data.
- Verify Sandra Sweet collapses from 43 rows to 1.
- Verify `service_tickets_quo_conv_uniq` index exists and rejects duplicate inserts.
- Verify `kind='conversation'` set on all 122 Quo + N Gmail rows.

**Edge function (post-deploy):**
- Manually invoke `sync-quo-tickets` twice in a row. Confirm no duplicate rows created (upsert is idempotent).
- Confirm new rows arrive with `kind='conversation'`.

**E2E (Playwright, light):**
- Inbox tab loads and shows rows.
- Promote modal flips a row to `kind='ticket'`, row disappears from Inbox, appears in Tickets.

## 9. Rollout sequence

1. Apply migration on prod (dedupes + adds columns + bulk-demotes).
2. Deploy `sync-quo-tickets` v12 with upsert fix.
3. Update `GMAIL_DELEGATED_MAILBOXES` secret to `support@virgohome.io` only.
4. Ship UI (Inbox tab + Promote modal + SupportTab filter).
5. Walk Reina + Junaid through the Inbox; collect immediate feedback.

Each step is independently reversible (column drop / function rollback / secret restore / UI revert). Steps 1–3 are backend and can ship without the UI; the Tickets tab stays usable in the meantime, but every Quo / Gmail row is hidden as a conversation until the UI catches up. If the UI lags, set `kind='ticket'` on rows operators want back temporarily.

## 10. File touch list

| File | Action |
|------|--------|
| `supabase/migrations/<timestamp>_service_inbox.sql` | New (section 5) |
| `supabase/functions/sync-quo-tickets/index.ts` | Edit (section 6.1) |
| `app/src/lib/service.ts` | Edit — add `useInbox`, disposition mutators, filter `useTickets` by `kind='ticket'` |
| `app/src/modules/Service/index.tsx` | Edit — add Inbox tab |
| `app/src/modules/Service/InboxTab.tsx` | New — list + filters + row actions |
| `app/src/modules/Service/PromoteToTicketModal.tsx` | New — modal component |
| `app/src/modules/Service/SupportTab.tsx` | Edit — consume the new `kind='ticket'` filter (one-line change if `useTickets` does the filtering) |
| `app/src/modules/Service/__tests__/InboxTab.test.tsx` | New — unit + filter tests |
| Supabase secret `GMAIL_DELEGATED_MAILBOXES` | Edit (manual via `supabase secrets set`) |

Approx total: ~600–800 LOC + ~80 SQL.
