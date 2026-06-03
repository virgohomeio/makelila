# Auto Follow-up Queue — Design Spec

**Date:** 2026-06-03
**Author:** Huayi Gao (with Claude)
**Status:** Draft for review

---

## 1. Problem

After the Quo-outbound backfill (commit `73b4a39`), 42 customers are still overdue for FU1 or FU2 — Reina either hasn't messaged them yet or messaged them more than the cadence window ago. Reaching out to each manually is repetitive: same opening, same context lookup, same intent. The repetitive part is automatable; the per-customer specificity (referencing past issues, current order state, prior conversation tone) is what makes the outreach worth doing at all.

## 2. Goal

Stand up a per-customer LLM-drafted SMS queue that Reina reviews + approves + sends, one click per customer. Drop the manual time from ~3min/customer to ~15s/customer while preserving Reina's voice and avoiding tone-deaf sends.

## 3. Decisions (locked in during brainstorming)

| Decision | Choice |
|----------|--------|
| Delivery channel | **SMS via OpenPhone (Quo).** Same channel + sender number Reina uses today. Voice / multi-channel deferred. |
| Approval gate | **Reina previews + approves each message** before it sends. Auto-batch deferred. |
| LLM context | **All four bundles:** profile (name, onboard_date, fu1/fu2 status, days overdue); prior Quo conversation history (last 20 msgs); order details (model, ship date, warranty); recent service tickets / returns / refunds / cancellations. |
| Queue UI | **Customers tab — "Overdue follow-ups" panel.** Reuses the context Reina already opens daily; no new top-level tab. |

## 4. Architecture

Two new edge functions + one React panel in the Customers module. No new DB table — drafts live in React state only (regenerate cheap; persist not worth the complexity).

```
Customers tab → "Overdue follow-ups" panel
        ↓ Generate drafts (button)
generate-followup-drafts edge fn
  ├─ fetch context bundle per customer
  ├─ call claude-haiku-4-5
  └─ return [{ customer_id, draft, skip_reason, context_summary }]
        ↓ React renders queue
Reina reviews → edits / approves / skips per row
        ↓ on approve
send-followup-sms edge fn
  ├─ POST OpenPhone /v1/messages
  ├─ insert ticket_messages row (auto-creates service_tickets if needed)
  └─ flip customers.fu1_status (or fu2_status) → 'messaged', append fu_notes
```

### 4.1 `generate-followup-drafts` edge function

**Path:** `supabase/functions/generate-followup-drafts/index.ts`

**Auth:** operator JWT only (calls the shared `authenticate()` from the security pass; rejects cron). No cron use case.

**Input:**
```ts
{ customer_ids?: string[] }  // omitted → all currently-overdue customers
```

**Behavior:**

1. Resolve the customer list. If `customer_ids` empty, run the same overdue query the UI shows:
   ```sql
   select id from customers
    where onboard_date is not null
      and (
        (fu1_status is null and (onboard_date::date + 7) < current_date) or
        (fu1_status is not null and fu2_status is null and (onboard_date::date + 30) < current_date)
      );
   ```
2. For each customer, gather the context bundle:
   - **Profile:** name, email, phone, onboard_date, fu1_status, fu2_status, fu_notes (last 500 chars).
   - **Order:** most recent row in `orders` where `customer_email = customer.email`. If `customer.email` is null, fall back to `customer_name = customer.full_name` (lowercase trimmed). Pull `order_ref`, `placed_at`, `country`, `batch` (if joined to units).
   - **Unit:** most recent row in `units` where `customer_name = customer.full_name` (lowercase trimmed). Pull `serial`, `batch`, `status`, `shipped_at`.
   - **Recent activity:** last 5 `service_tickets` for this customer_id; last 1 row each from `returns`, `refund_approvals`, `order_cancellations` linked via `customer_email`. Render as a flat list of `{kind, status, created_at, summary}` items, newest first.
   - **Quo history:** last 20 `ticket_messages` rows joined via `service_tickets` where `source='quo'` AND `customer_id = customer.id`, chronological. Render each as `<direction> <YYYY-MM-DD>: <body_text first 200 chars>`.
3. Compose a prompt (template below) and call `claude-haiku-4-5-20251001`. Force JSON output via tool use OR strict prompt + JSON parse with fallback.
4. Apply **automatic skip rules** before calling Claude (don't waste tokens):
   - No `customer.phone` → skip with reason "No phone on file".
   - Active return/refund/cancellation (`returns.status in ('created','in_transit','received','inspecting')` OR `refund_approvals.status in ('manager_review','finance_review','approved')` OR `order_cancellations.status='submitted'`) → skip with reason "Active return/refund/cancellation — manual touch only".
   - Last outbound Quo message < 7 days ago → skip with reason "Already messaged within 7 days".
5. Return:
   ```ts
   {
     drafts: [
       {
         customer_id: string,
         customer_name: string,
         customer_phone: string | null,
         days_overdue: number,
         fu_kind: 'fu1' | 'fu2',
         draft_message: string | null,   // null when skipped
         skip_reason: string | null,
         context_summary: string,         // 1-line for the UI
       }
     ]
   }
   ```

**Prompt template:**

```
You are drafting a short SMS follow-up from Reina at VCycene (the company
that makes the Lila Pro composter). The customer is overdue for a
{FU_KIND} check-in.

Constraints on the message:
- 1-3 sentences max. SMS-length.
- Open warmly using the customer's first name.
- Reference at least one specific detail from the context below (an issue
  they raised, where they're at in onboarding, their product/unit serial,
  or the time since they got the unit).
- End with an open question or a clear "let me know if..." invitation.
- Sound like Reina — friendly, lowercase casual, no marketing speak.
- Do NOT mention "follow-up", "check-in", or "we noticed you're overdue".
- Do NOT use the words "appreciate", "valued customer", "outreach".

Customer profile:
- Name: {NAME}
- Onboarded: {ONBOARD_DATE} ({DAYS_OVERDUE} days past the {FU_KIND} window)
- Unit: {UNIT_SERIAL} ({BATCH})

Recent context:
{ACTIVITY_SUMMARY}

Last few Quo messages with this customer (chronological):
{QUO_HISTORY}

Output strict JSON, no prose:
{"draft": "<message text>", "skip_reason": null}
OR if you cannot draft a good message:
{"draft": null, "skip_reason": "<short reason>"}
```

**Error handling:**
- Per-customer Claude failure → return `{draft: null, skip_reason: "LLM error: <msg>"}` for that customer, continue.
- Whole-batch Anthropic API failure → return 502 with the error.

### 4.2 `send-followup-sms` edge function

**Path:** `supabase/functions/send-followup-sms/index.ts`

**Auth:** operator JWT only.

**Input:** `{ customer_id: string; message: string }`

**Steps:**
1. Fetch `customers.phone`. If null, return 400 — `cannot SMS without phone`.
2. POST to OpenPhone `/v1/messages`:
   ```
   from = <OPENPHONE_PHONE_NUMBER_IDS first entry — the Lila Pro Service line>
   to = customer.phone
   content = message
   ```
3. Find-or-create a `service_tickets` row for this customer's Quo conversation:
   - If any `service_tickets` row with `source='quo'` AND `customer_id = customer_id` exists, use the most recently active one (max `last_message_at`). This handles both `kind='conversation'` (still in Inbox) and `kind='ticket'` (promoted) — append to whichever the operator's last touch was on.
   - Else insert a new ticket: `source='quo', kind='conversation', subject='Follow-up SMS', customer_id=..., customer_name=..., customer_phone=...`. Leave `quo_conversation_id` null until the next sync-quo-tickets cron tick reconciles the OpenPhone-side ID.
4. Insert into `ticket_messages`:
   - `ticket_id` = ticket from step 3
   - `gmail_message_id` = `'quo:auto-fu-<uuid>'` (unique sentinel; OpenPhone returns a real message id we can append later)
   - `direction='outbound'`
   - `body_text` = message
   - `sent_at = now()`
5. Update `customers`:
   - If `fu1_status is null` → set `fu1_status='messaged'`.
   - Else if `fu2_status is null` → set `fu2_status='messaged'`.
   - Append to `fu_notes`: `[Makelila <YYYY-MM-DD>] Auto FU SMS sent (text: "<first 80 chars>…")`.
6. Return `{ ok: true, openphone_message_id, ticket_id }`.

**Idempotency:** if the same `(customer_id, message)` is submitted twice within 5 minutes (rapid double-click), return the prior result without re-sending. Simple: query `ticket_messages` for matching body in the customer's last 5 min.

### 4.3 UI — "Overdue follow-ups" panel in Customers tab

**File:** modify `app/src/modules/Customers/index.tsx`; new component `OverdueFollowupPanel.tsx` in the same folder.

Top of the Customers page, above the existing filter row, when overdue > 0:

```
┌─────────────────────────────────────────────────────────────────┐
│ 42 customers overdue for follow-up                              │
│ [ Generate drafts for first 10 ▾ ]                              │
│ Skip rules: no phone · active return/refund · messaged <7d ago  │
└─────────────────────────────────────────────────────────────────┘
```

The dropdown options: 5 / 10 / 20 / all. Default 10. Click → calls `generate-followup-drafts` with that many customer_ids (ordered by days_overdue desc).

While generating: spinner with "Drafting 10 messages… (~10s)".

After response, render each draft:

```
┌─ Sandra Sweet · FU1 · 14d overdue ─────────────────────────────┐
│ Context: shipped 2026-05-12 (P100), no Quo activity since.     │
│                                                                 │
│ [textarea editable, prefilled with draft message]              │
│                                                                 │
│ [ ✓ Approve & send ]   [ Skip ]                                │
└─────────────────────────────────────────────────────────────────┘

┌─ Brent Neave · FU2 · 21d overdue ──────────────────────────────┐
│ ⚠ SKIPPED — Active return in progress (RTN-0033, manager_review) │
└─────────────────────────────────────────────────────────────────┘
```

Approve → fires `send-followup-sms`, row collapses with `✓ Sent to <name> at <hh:mm>`. Skip → row collapses with `— Skipped`. Errors render in red inline; row stays open for retry.

### 4.4 Cost + scale

Per 42-customer run:
- Claude (drafts): ~5K input + 200 output tokens per customer × 42 ≈ $0.07 total.
- OpenPhone SMS: ~$0.01 per message × 42 ≈ $0.42 total.
- ~**$0.50 per full run.** Reina can do this weekly; cost is irrelevant.

Run time: ~10s for 10-customer batch (Claude is fast). Send: instant per click.

## 5. Phased rollout

Single phase. The feature is additive — no policies to migrate, no schema to alter. New edge functions ship via MCP; UI ships via the next GH Pages build.

**Order:**
1. Deploy `generate-followup-drafts` edge fn (no UI yet — invoke via MCP to confirm output).
2. Deploy `send-followup-sms` edge fn (invoke via MCP on a test customer in EMAIL_TEST_RECIPIENT-style flag — see §7).
3. Ship the UI panel.
4. Reina runs a first 5-customer batch under supervision.

## 6. Out of scope (deferred)

- **Voice calls.** SMS only for v1.
- **Auto-batch send without approval.** Reina-approval-only for v1.
- **Multi-language.** English only.
- **Per-customer template selection.** Single LLM-drafted message; no template library yet.
- **Inbound-reply detection.** The existing 5-min Quo cron already pulls replies into the Service Inbox; no extra wiring needed.
- **Audit dashboard / send-rate metrics.** `activity_log` + `fu_notes` together carry enough audit info for v1.
- **A/B variant testing.** Single message per customer.

## 7. Testing strategy

**Pre-deploy guard rail:** add a `FOLLOWUP_SMS_TEST_PHONE` env var. If set, `send-followup-sms` redirects every send to that number with a `[TEST → <real phone>]` prefix on the body (mirrors the existing `EMAIL_TEST_RECIPIENT` pattern in `send-fulfillment-email`). Unset for go-live.

**Generation tests:**
- Invoke `generate-followup-drafts` with `customer_ids=[<known-active-return-customer-id>]` → response has `skip_reason="Active return..."`, `draft=null`.
- Invoke with `[<recently-messaged-customer-id>]` → response has `skip_reason="Already messaged within 7 days"`.
- Invoke with `[<happy-onboarded-customer-id>]` → response has non-null `draft` that includes the customer's first name AND references their unit/onboard context.

**Send tests:**
- Set `FOLLOWUP_SMS_TEST_PHONE=<your number>` on the project.
- Approve a draft in the UI → SMS arrives at your number prefixed `[TEST → <real>]`.
- Verify DB side-effects: `ticket_messages` row inserted; `customers.fu1_status='messaged'`; `fu_notes` appended.

**Unit tests:** standard Vitest for the React panel — render the panel with mocked drafts; assert Approve button calls `send-followup-sms` with the right args; assert Skip collapses without sending.

## 8. File touch list

| File | Action |
|------|--------|
| `supabase/functions/generate-followup-drafts/index.ts` | Create |
| `supabase/functions/send-followup-sms/index.ts` | Create |
| `app/src/lib/customers.ts` | Edit — add `generateFollowupDrafts()` + `sendFollowupSms()` client wrappers |
| `app/src/modules/Customers/OverdueFollowupPanel.tsx` | Create |
| `app/src/modules/Customers/index.tsx` | Edit — mount the panel above the existing filter row |
| `app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx` | Create |
| Supabase secret `ANTHROPIC_API_KEY` | Already set (Phase 1 of verify-address) — reuse |
| Supabase secret `OPENPHONE_API_KEY` + `OPENPHONE_PHONE_NUMBER_IDS` | Already set — reuse |
| Supabase secret `FOLLOWUP_SMS_TEST_PHONE` | Manual: set during testing, unset for go-live |

## 9. Risk + mitigations

- **LLM produces a wrong / tone-deaf message** → Reina's per-message approval gate catches it. The skip rules catch the highest-risk cases automatically.
- **Wrong-number send** → SMS uses the same `customer.phone` field Reina already trusts for manual follow-ups; no new data source.
- **Customer perceives the SMS as bot-generated** → prompt explicitly bans marketing speak + forces specific-context references. Reina edits any draft that doesn't sound like her.
- **OpenPhone rate limits** → 42 sends serialized with ~1s gap stays well under their 10/sec ceiling. Don't parallelize sends.
- **Phase ordering with the security pass** → both `generate-followup-drafts` and `send-followup-sms` use `authenticate()` from `_shared/auth.ts`. If the security pass hasn't shipped yet, ship these with a temporary inline auth check (verify JWT + check profiles.is_internal) — replace with the wrapper once it lands. Note the dependency in the implementation plan.

## 10. Open questions

None. All decisions locked in during brainstorming.
