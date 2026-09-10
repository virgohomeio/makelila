# Customer communication indicator — Sales tab

**Date:** 2026-09-10 · **Module:** OrderReview (Sales) · **Operator:** Huayi

## Problem

Before an operator approves an order for shipment they have no view of what the
customer has recently said to support. The signal that a customer has changed
their mind, wants to cancel, has moved, or is hesitating lives in two places the
Sales tab cannot see: the two support mailboxes
(`support@virgohome.io`, `support@lilacomposter.com`) and the Quo (OpenPhone)
SMS line. Units get shipped to customers who have already asked to cancel.

## What ships

A summary box inside the **Customer** card of an order's detail panel, plus a
compact chip on the order row, showing a one-line verdict:

- **Clear to ship** — no contact on file, or the contact contains nothing that
  bears on shipping.
- **Customer communication unclear — confirm the desire to ship** — with the
  specific concern named (changed their mind, asked to cancel, address change,
  unresolved complaint, …) and up to two dated evidence excerpts.

## Findings that shape the design (verified 2026-09-09)

1. **Support email has never reached the database.** `sync-gmail-tickets` is
   deployed and cron'd every 5 min, but returns
   `{"skipped":true,"reason":"GOOGLE_SERVICE_ACCOUNT_KEY or GMAIL_DELEGATED_MAILBOXES not configured"}`
   on every run. `gmail_sync_state` is empty and zero `service_tickets` have
   `source='gmail'`. Enabling it is a Google Workspace admin task, not code.
2. **Quo is in the database but 5 weeks stale.** Newest `ticket_messages.sent_at`
   is 2026-08-05; the live Quo inbox has continuous traffic since. The cron
   fires but `net._http_response.status_code` is null — the run times out.
   Cause: `fetchMessagesForConversation` re-pulls every active conversation's
   entire history (up to 1,000 messages, no `createdAfter` filter) on every
   5-minute run, with no wall-clock budget. Because `since` is derived from
   `max(last_message_at)` and the run never commits a full pass, the watermark
   can never advance — a permanent wedge.
3. **The browser cannot read either source.** The app is React + Supabase; the
   assessment must be computed server-side and stored.

Consequence: the feature is built whole, but the email leg stays dark until the
two secrets are set. The box states which channels it actually scanned, so a
"Clear to ship" is never silently based on half the evidence.

## Architecture

```
Quo API ──► sync-quo-tickets ──┐
                               ├─► service_tickets + ticket_messages
Gmail API ─► sync-gmail-tickets┘   (email leg dark until secrets set)
                                        │
                                        ▼
                        assess-order-communication (edge fn, cron 15m)
                          · resolve customer identity from the order
                          · gather messages, fingerprint them
                          · LLM verdict via _shared/llmProviders.ts
                                        │
                                        ▼
                              order_comm_assessments
                                        │
                                        ▼
                    lib/orderComms.ts ──► CommsSummary in CustomerCard
```

### 1. `order_comm_assessments`

One row per order (`order_id` primary key).

| column | type | meaning |
|---|---|---|
| `order_id` | uuid PK → orders(id) cascade | the assessed order |
| `verdict` | text | `clear` \| `unclear` \| `no_contact` |
| `headline` | text | the one-liner shown in the box |
| `concerns` | text[] | fixed vocabulary, see below |
| `evidence` | jsonb | `[{channel, direction, sent_at, excerpt, ticket_id}]`, ≤3 |
| `channels_scanned` | jsonb | `{quo:{connected,last_synced_at,message_count}, email:{…}}` |
| `message_count` | int | messages fed to the model |
| `last_message_at` | timestamptz | newest message considered |
| `input_fingerprint` | text | sha256 of the message ids — skip re-running |
| `model` | text | provider that answered |
| `assessed_at` | timestamptz | |
| `error` | text | last failure, null on success |

Concern vocabulary (stable strings the UI labels):
`cancel_intent`, `refund_request`, `hesitation`, `address_change`,
`contact_change`, `delivery_timing`, `unresolved_complaint`, `payment_issue`,
`other`.

RLS: internal profiles read; service role writes.

### 2. `assess-order-communication` edge function

- Body `{order_id}` for one order, or `{scope:'pending', limit}` for the cron.
- Identity: `orders.customer_id`, plus lower-cased email and last-10-digit
  phone, matched against `service_tickets.customer_id / customer_email /
  customer_phone`.
- Window: messages from 120 days back, newest 60 kept.
- Fingerprint short-circuit: unchanged message set ⇒ no LLM call.
- No messages ⇒ `no_contact` with no LLM call.
- LLM returns strict JSON `{verdict, headline, concerns[], evidence[]}` via the
  existing Claude→Qwen→OpenAI chain (`_shared/llmProviders.ts`). A total
  provider failure writes `error` and leaves the previous verdict in place.
- Cron every 15 minutes over orders still awaiting review.

### 3. Quo sync repair

Three changes to `sync-quo-tickets`, minimum needed to unwedge it:

- Pass `createdAfter` (the watermark minus a 1-day overlap) to `/v1/messages`,
  so a conversation's whole history is not re-pulled every run.
- A wall-clock deadline (100s). On expiry the run returns `partial:true`;
  per-conversation progress is already committed.
- Process conversations oldest-activity-first so each partial run advances the
  watermark instead of re-treading the same head of the list.

### 4. Frontend

- `lib/orderComms.ts` — types, `useOrderCommAssessment(orderId)` (fetch +
  realtime **+ refetch on reconnect**, avoiding the known fetch-once-and-go-stale
  trap), `useOrderCommAssessments()` bulk hook for row chips,
  `requestCommAssessment(orderId)` for the Re-check button, and the pure
  presentation mapping (verdict → tone, label, channel footnote).
- `modules/OrderReview/detail/CommsSummary.tsx` — the box, rendered inside
  `CustomerCard` under the phone line.
- Row chip in `OrderRow.tsx`.
- Styles in `OrderReview.module.css` using existing success/warning tokens.

### States shown

| state | box |
|---|---|
| loading | muted skeleton line |
| `no_contact` | green · "Clear to ship — no support contact on file" |
| `clear` | green · headline |
| `unclear` | amber · headline + concern chips + ≤2 dated excerpts + Re-check |
| `error` / never assessed | muted · "Not yet assessed" + Re-check |

Every state carries the channel footnote, e.g.
`Scanned: Quo (to Sep 9) · Support email not connected`.

## Testing

- `lib/orderComms.test.ts` — verdict→presentation mapping, channel footnote
  wording (including the "not connected" case), staleness label.
- `detail/__tests__/CommsSummary.test.tsx` — each state renders its tone and
  the footnote; unclear state lists concerns and excerpts.
- `_shared/commAssessment.test.ts` — pure helpers: identity matching,
  fingerprinting, model-JSON parsing, no-messages short-circuit.

## Out of scope

- Setting up the Google Workspace service account (admin task; the function is
  already written and cron'd, it needs only the two secrets).
- Backfilling Quo history older than the current watermark.
