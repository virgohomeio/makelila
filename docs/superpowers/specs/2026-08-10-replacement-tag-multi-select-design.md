# Queued for Replacement as a multi-select tag — design

Date: 2026-08-10
Operator: Huayi (huayi@virgohome.io)
Module: Service (Support Tickets) + Order Review (replacement orders)

## Problem

A ticket queued for a replacement cannot carry any other label.

Reported against Manjeet Kaur's ticket `83a467cb-4caa-4c52-8a72-12a0da7bdd57`
("Moist compost issues; need to be sent Jumpers to bypass microswitch for light
flashing issues") — `status = 'queued_for_replacement'`, `tags = []`, linked to
replacement order `e198e121-1bb2-4731-89b6-a3f965eadd5b`.

Three causes:

1. The "Status" button row in `TicketDetailPanel.tsx` is single-select and
   writes `service_tickets.status`. Selecting any other state *replaces*
   `queued_for_replacement` rather than adding alongside it.
2. A multi-select `tags text[]` column exists (migration
   `20260714000000_service_tickets_tags.sql`, live in prod) and
   `updateTicketTags()` exists in `lib/service.ts` — but **no UI calls it**.
   Tags are read-only today.
3. Creating a replacement order writes `status = 'queued_for_replacement'`
   (`lib/orders.ts` in `createReplacementOrder` and `createPendingReplacement`),
   clobbering the operator's status and never writing a tag.

The **read** path for tags is already complete and needs no work:

- `SupportTab.tsx` renders one 🏷 chip per distinct tag across a customer's open
  tickets, skipping tags a status pill already shows.
- `SupportTab.tsx` status filter already matches `t.status === f || t.tags.includes(f)`.
- `StatusPills` already expands a `queued_for_replacement` **tag** into
  "Queued for P100X Replacement" / "Queued for PARTS Replacement" via
  `replacementQueueKindsByTicket`.
- `replacementQueue.ts` `isQueuedForReplacement()` already checks status **or** tag.
- `followupStatus.ts` already derives `queued_replacement` from either.

Only the **write** path is missing.

## Decisions

| Question | Decision |
|---|---|
| Where does the replacement marker live? | **Tag only.** `queued_for_replacement` leaves the Status button row and becomes a tag. |
| What does `status` become on replacement create? | **Untouched.** The operator's status choice is never overwritten — that is the point of the fix. |
| Tag vocabulary | **Reuse `TICKET_STATUSES`** (all 7). No new type, no new colours — `STATUS_META` already covers them. |
| Tag lifecycle | **Auto-clear on ship and on cancel.** The tag means "waiting on a replacement". |
| Backfill of 31 existing rows | Add the tag, set `status = 'waiting_on_customer'`. |

## Design

### 1. Data model

No schema change. `service_tickets.tags text[] NOT NULL DEFAULT '{}'` is already
in prod. `status` remains the single workflow state that drives SLA aging,
`closed_at`/`resolved_at`, the state machine, and the close-side effects.
`queued_for_replacement` remains a legal `status` value in the DB CHECK
constraint (`20260605120000_ticket_status_set.sql`) — the migration below is the
only thing that clears it from live rows, and it stays in `TICKET_STATUSES` as
the tag vocabulary.

### 2. Split the status vocabulary — `lib/service.ts`

`TICKET_STATUSES` stays all 7 values (DB vocabulary + tag vocabulary). Add:

```ts
/** The workflow states an operator can set as a ticket's `status`.
 *  Excludes 'queued_for_replacement' — that is a TAG now (set automatically
 *  when a replacement order is created), so it can coexist with any status. */
export const WORKFLOW_STATUSES = TICKET_STATUSES.filter(s => s !== 'queued_for_replacement');
```

### 3. Status row drops one button — `TicketDetailPanel.tsx`

The Status section iterates `WORKFLOW_STATUSES` instead of `TICKET_STATUSES`.
Behaviour is otherwise unchanged (single-select, Complete closes/reopens,
deselecting Action Needed → In Progress).

### 4. New Tags row — `TicketDetailPanel.tsx`

A new `detailSection` directly under Status, matching the Status/Priority row
markup:

```
Tags
[🏷 Action Needed] [🏷 In Progress] [🏷 Awaiting Customer Response]
[✓ 🏷 Queued for Replacement] [🏷 Call Scheduled] [🏷 On Hold] [🏷 Complete]
```

- Multi-select. Click toggles the tag on/off.
- Active = `btnPrimary` with `STATUS_META[tag].color`, inactive = `btnSecondary`
  with the colour as text — same treatment the Status row uses.
- Calls `updateTicketTags(ticket.id, nextTags)` through the panel's existing
  `run()` wrapper (which handles `busy` and error surfacing).
- Ordering is `TICKET_STATUSES` order, so the row is stable regardless of what
  is selected.

`updateTicketTags` already logs `ticket_tags_changed` to the activity log.

### 5. Auto-tag on replacement create — `lib/orders.ts`

Both `createReplacementOrder` (~L930) and `createPendingReplacement` (~L1020)
currently do:

```ts
.update({ replacement_order_id: row.id, status: 'queued_for_replacement' })
```

Replace with a read-modify-write that appends the tag and leaves `status` alone.
A shared helper keeps both sites honest:

```ts
/** Add 'queued_for_replacement' to a ticket's tags without touching its status
 *  or disturbing tags the operator set. Deduped. */
async function tagTicketQueuedForReplacement(ticketId: string, orderId: string): Promise<void>
```

It reads `tags`, unions in `queued_for_replacement`, and writes back together
with `replacement_order_id` in one update.

Race note: this is a read-modify-write, not an atomic array append. Two
concurrent replacement creations against the same ticket could drop one
operator's concurrent tag edit. Acceptable — replacements are created one at a
time by one operator from the ticket panel, and the tag set is small and
idempotent. Not worth an RPC.

### 6. Auto-clear on ship and cancel — `lib/orders.ts`

Symmetric helper:

```ts
/** Remove 'queued_for_replacement' from a ticket's tags. No-op when absent.
 *  Leaves every other tag and the ticket's status alone. */
async function untagTicketQueuedForReplacement(ticketId: string): Promise<void>
```

Called from two places:

- **`releaseAndDeleteReplacement()`** (~L684) — in the block that already nulls
  `replacement_order_id`. This covers *both* cancel paths:
  `cancelReplacementOrder` (manual, from Order Review) and
  `cancelPendingReplacementsForTicket` (auto, when a ticket is closed).
- **`markOrderShipped()`** (~L1100) — currently does not touch the ticket at
  all. Its `select` must be widened to include `kind, linked_ticket_id`, then
  clear the tag when `kind === 'replacement' && linked_ticket_id`.

Both are best-effort: wrapped in `.catch()` with a `console.warn`, matching the
existing precedent at `service.ts:985` (`cancelPendingReplacementsForTicket` on
ticket close). A tag-clear failure must not fail a ship or a cancel.

`markOrderDelivered()` needs no change — it already closes the linked ticket, and
delivery follows shipping, so the tag is already gone.

### 7. Classifier — `supabase/functions/_shared/classifier-llm.ts`

The LLM classifier can emit `queued_for_replacement` as a ticket `status`
(prompt line: "confirmed hardware defect, unit replacement arranged or
pending"). Under the new model that would reintroduce the clobbering bug from a
second direction.

Fix: drop `queued_for_replacement` from the classifier's allowed `status` enum
and from the prompt's status list. The tag is set by the replacement-order
workflow, which is authoritative — the classifier should not guess at it from
message text. Tickets it would have marked queued become `in_progress`.

### 8. Backfill migration

`supabase/migrations/<ts>_ticket_queued_replacement_to_tag.sql`:

```sql
UPDATE service_tickets
   SET tags   = array_append(tags, 'queued_for_replacement'),
       status = 'waiting_on_customer'
 WHERE status = 'queued_for_replacement'
   AND NOT ('queued_for_replacement' = ANY(tags));
```

31 rows in prod as of 2026-08-10. Rationale for `waiting_on_customer`: these
tickets are waiting on a replacement to arrive, so the SLA clock should not run
against ops, and they should not inflate Action Needed (194 → 225).

Visually nothing changes in the Support list — the 🏷 chip replaces the status
pill, and `StatusPills` renders the same "Queued for P100X Replacement" text for
both variants.

Per `docs/session-notes/` conventions, DB migrations are gated behind the manual
workflow and are not auto-applied on push.

## Testing

**Vitest**

- `lib/orders.test.ts` — the existing assertion at ~L235 expects
  `{ replacement_order_id: 'o9', status: 'queued_for_replacement' }`. Update to
  assert `tags` contains `queued_for_replacement` and that **no** `status` key
  is present in the update payload. Add the same for `createReplacementOrder`.
- New: tag append is deduped and preserves pre-existing tags.
- New: tag removal preserves other tags and is a no-op when the tag is absent.
- New: `markOrderShipped` clears the tag for a replacement with a linked ticket,
  and does not touch tickets for a non-replacement order.
- `modules/Service/__tests__/replacementQueue.test.ts` already covers the
  tag-driven path (`t('t1', { status: 'in_progress', tags: ['queued_for_replacement'] })`)
  — no change needed, but it is the regression guard for this design.

**Component**

- `SupportTab.test.tsx` — a ticket with `status: 'in_progress'` and
  `tags: ['queued_for_replacement']` plus a resolvable replacement order still
  renders the "Queued for P100X Replacement" chip.
- `TicketDetailPanel` — the Tags row toggles a tag on and off and calls
  `updateTicketTags` with the expected array; the Status row no longer offers a
  "Queued for Replacement" button.

**Manual**

1. Open Manjeet Kaur's ticket `83a467cb`. After the backfill it reads
   `status = Awaiting Customer Response` + 🏷 Queued for PARTS Replacement.
2. Add 🏷 On Hold. Both chips persist. Change status to In Progress — the
   replacement tag survives.
3. Create a replacement from another ticket sitting at Action Needed. Status
   stays Action Needed; the replacement tag appears.
4. Ship that replacement from Order Review. The tag clears; status is untouched.
5. Cancel a different queued replacement. The tag clears.

## Out of scope

- Free-form / custom tag vocabulary beyond `TICKET_STATUSES`.
- Making `status` itself multi-select.
- Backfilling tags from historical replacement orders that already shipped.
