# Design: Lily chat analytics in makeLILA

**Date:** 2026-10-25
**Owner:** Ryan Yuan
**Modules:** Lovely app › Lily (guide chatbot) · makeLILA › Lovely › **Lily Chats** (new tab)
**Status:** design approved, pending implementation plan

## Why

Customers ask Lily, the AI assistant in the Lovely app, about composting, their
machine and the app. Today the team has no view of those conversations. Each
reply is streamed to the customer and then discarded. The only thing stored is a
per-user daily request count (`ai_usage_daily`) used for rate limiting. So
nobody can see who is struggling, what customers keep asking, or where Lily's
answers fall short.

The ask is a section in makeLILA that shows **the chat history** plus a **chat
summary**: what the customer talked about, **how they're feeling**, and **what
kinds of questions they have**. Customer service (Huayi, Reina) uses it to spot
frustrated customers and contact them, and to see what Lily gets asked most.

## Scope decisions (Ryan's)

| Decision | Choice |
|---|---|
| Which bot | **Lily in the Lovely app only.** Not lila-bot (Messenger/Instagram/Quo), Zipchat, or the planned internal makeLILA AI (#100). |
| What it shows | Chat history + a summary covering what was discussed, how the customer feels, and what kinds of questions they ask |
| Organization | **One profile per customer** (layout "B"): customer list on the left; selected customer's running summary, mood over time, question types and chat history on the right |
| Contact details | Customer's **phone and email as plain text next to their name** (not click-to-call / click-to-email links) so staff can contact them if needed |
| Overview | All four pieces: number row, "most asked about", "questions Lily couldn't answer", frustrated customers first in the list |
| Weekly digest | **Left out** |
| Telling existing users | **Update the posted privacy policy only.** No in-app notice, no re-acceptance |

Ryan reviewed and approved the behind-the-scenes approach in summary form
(save chats in the Lovely app → AI summary once a chat goes quiet → makeLILA
reads through a secured function → privacy policy update). The specifics below
are Claude's calls unless marked otherwise.

## Goals

- Every Lily conversation from now on is saved, attributed to the customer's
  Lovely account and serial number.
- Each finished conversation gets an AI-written summary, a feeling and question
  types. Each customer gets a running summary across all their chats.
- makeLILA operators can find a customer, read their summary and transcripts,
  and see their phone and email in one place.
- The team can see at a glance what Lily is asked most and what she couldn't
  answer, so Lily's knowledge (`lib/chatbot/knowledge.ts` in the Lovely repo)
  can be improved.

## Non-goals

- Conversations from before this ships. They were never stored, so none exist.
- Other bots (lila-bot, Zipchat, Quo auto-reply, makeLILA AI #100).
- A weekly or AI-written digest across all chats.
- Replying to customers from makeLILA, or click-to-call / click-to-email links.
- Alerts or notifications when a customer turns frustrated.
- Editing Lily's knowledge from makeLILA.
- Changing Lily's model. **Note for the team, not in scope:** Lily currently
  runs on `claude-opus-4-8` (`app/api/guide/chat/route.ts`), not Haiku as her
  original design said. That matters for cost, which Huayi has already raised.

## Anti-goals (would make this a failure even if it works)

- **Chat content readable by anyone without a makeLILA operator login.** Chats
  are customer PII. The new tables must be service-role only, like
  `ai_usage_daily` and `users`, never anon-readable like `compost_feedback`.
- **Saving chats breaks or slows Lily for customers.** Persistence must never
  block the stream or turn a successful reply into an error.
- **Lily's injected machine-status context saved as if the customer said it.**
  The route prepends a synthetic "(Context — my machine's current status)"
  exchange. It must not appear in saved transcripts.
- **Summaries that invent things.** Feeling and question types must come from
  what the customer actually wrote. When unclear, use `neutral` and `other`.

## What the team sees

A new **Lily Chats** tab in makeLILA's Lovely module, after Firmware.
Like the other Lovely tabs, it's open to every signed-in operator.

**Overview strip (top):**

| Piece | Definition |
|---|---|
| Chats (30 days) | Conversations started in the last 30 days |
| Customers chatting | Distinct Lovely users with a conversation in the last 30 days |
| Frustrated right now | Customers whose most recent summarized conversation, if it falls in the last 30 days, has feeling `frustrated`. Shown in red when > 0 |
| Lily couldn't answer | Number of unanswered questions recorded in the last 30 days |
| Most asked about | Count of conversations per question type over the last 30 days, as horizontal bars. A conversation with two types counts toward both |
| Questions Lily couldn't answer | The unanswered questions from the last 30 days, grouped by identical text (case-insensitive), most-asked first, showing "asked N×". The top 3 are shown, with a "+ N more" expander |

**Staff accounts (Claude's call):** Lovely accounts with an `@virgohome.io`
email are excluded from every overview number, so testing doesn't skew them.
They still appear in the customer list, tagged "Staff".

**Customer list (left):** search by name, email or serial. Each row shows the
name, a feeling chip for the latest conversation, the chat count and the last
chat date. Sort order: frustrated-right-now customers first, then most recent
chat.

**Customer profile (right), for the selected customer:**

1. Header: name, then **phone · email as plain text** right next to or under the
   name, then serial number and "Lovely user since <date>".
   - Phone: the Lovely account's `phone_number`. If that's empty, use the
     matched makeLILA customer's phone. If both are empty, show "No phone on file".
     Use the same matching the customer timeline already uses (app link, then
     paired serial, then email; see `app/src/lib/customerTimeline.ts`).
2. **Summary across all chats:** the customer's running summary, 2–4 sentences.
3. **How they're feeling:** feeling chips for each summarized conversation,
   oldest → newest (for example Happy → Neutral → Frustrated).
4. **What they ask about:** question-type chips with counts across all their
   conversations.
5. **Chat history:** one row per conversation, newest first: date, the first
   customer message (cut to one line), and the conversation's own one-line
   summary. Expanding a row loads and shows the full transcript.

Empty state (nothing saved yet): "No Lily conversations yet. Chats are saved
from <ship date> onward."

The approved mockup is in the brainstorm session
(`.superpowers/brainstorm/1723-1792961750/content/lily-chats-overview-v3.html`,
gitignored, local only). This section is the authoritative description.

**Labels (Claude's call):**
- Feelings: `happy` → "Happy" (green), `neutral` → "Neutral" (grey),
  `frustrated` → "Frustrated" (red).
- Question types (fixed list, defined once and mirrored on both sides):
  `what_can_i_compost` "What can I compost", `troubleshooting`
  "Troubleshooting", `machine_status` "Machine status", `app_help` "App help",
  `orders_shipping` "Orders & shipping", `other` "Other".

## How it works

```
Lovely app (Next.js)            Lovely Supabase project (arfdopgbvlfmhmcfghhl)        makeLILA
─────────────────────           ───────────────────────────────────────────          ────────
/api/guide/chat ──saves──▶  lily_conversations / lily_messages
                                   │
                    lily-summarize (every 15 min) ──Claude Haiku──▶ summary columns +
                                                                  lily_customer_summaries
                                   │
                    lovely-lily-chats (operator-JWT gated) ◀──fetch── Lovely › Lily Chats tab
```

### 1. Saving conversations (Lovely repo `beta-lovelyapp-host`)

**New migration** `schema/migrations/lily_chats_<date>.sql`, also reflected in
`schema/schema.sql`. Shape (the builder may refine names and types):

```sql
lily_conversations
  id               uuid primary key            -- generated by the client, see below
  user_id          uuid not null references users(id) on delete cascade
  serial_number    text                        -- serial at chat time
  started_at       timestamptz not null default now()
  last_message_at  timestamptz not null default now()
  message_count    integer not null default 0
  -- written by lily-summarize:
  summary          text                        -- one line
  feeling          text check (feeling in ('happy','neutral','frustrated'))
  topics           text[] not null default '{}'
  unanswered_questions text[] not null default '{}'
  summarized_at    timestamptz

lily_messages
  id               uuid primary key default gen_random_uuid()
  conversation_id  uuid not null references lily_conversations(id) on delete cascade
  role             text not null check (role in ('user','assistant'))
  content          text not null
  created_at       timestamptz not null default now()

lily_customer_summaries
  user_id          uuid primary key references users(id) on delete cascade
  summary          text not null
  updated_at       timestamptz not null default now()
```

Enable RLS on all three and `REVOKE ALL ... FROM authenticated, anon`, the same
as `ai_usage_daily`. Add indexes on `lily_conversations(user_id, started_at)`
and on the summarizer's "needs summary" lookup.

`on delete cascade` from `users` (which cascades from `auth.users`) means that
deleting a Lovely account deletes its chats and summaries automatically. That is
the retention rule for v1. There is no time-based expiry.

**Client (`components/guide-chat.tsx`):** generate a `conversationId`
(`crypto.randomUUID()`) when the first message of a chat is sent. Send it with
every request: `{ conversationId, messages }`. A page reload starts a new
conversation, which is fine.

**Route (`app/api/guide/chat/route.ts`):**
- Accept an optional `conversationId`. If it's missing or not a UUID, the route
  still answers. It generates one server-side and the chat is saved under that
  id. A client that hasn't updated yet just produces one-message conversations.
- If `conversationId` already exists for a different `user_id`, don't append to
  it. Start a fresh conversation id for this user instead.
- Save only what's new on each request: the **last user message** (the client
  re-sends the full history every time) and the **assistant's final text**
  after the stream ends. Never save the injected machine-context exchange.
- Upsert the conversation row (set `serial_number`, bump `last_message_at` and
  `message_count`). If `summarized_at` was set, the conversation will be
  re-summarized because `last_message_at` is now later (see below).
- Saving happens after the stream completes and **fails open**: log the error
  with `logError` and never affect the customer's response. If the stream
  errored and produced no assistant text, save the user message only.
- Use the existing service client. Rate limits and quota are unchanged.

All entry points into Lily (Guide page, the Ask Lovely card on Chambers,
humidity-alert links via `?ask=`) go through this one route, so all of them are
captured.

### 2. Summaries (Lovely Supabase project)

**`lily-summarize`** edge function, deployed to the Lovely project. Source
lives in the Lovely repo under `supabase/functions/`, next to `push-cron`, and
it runs every 15 minutes.

- **A conversation needs a summary** when `last_message_at < now() - 30 minutes`
  AND (`summarized_at is null` OR `summarized_at < last_message_at`).
- Process a bounded batch per run (for example 25, oldest first) so one run
  can't blow up cost or time.
- **Per conversation:** send the transcript to **Claude Haiku**
  (`claude-haiku-5-5`, the current cheapest model) and get back structured
  JSON with:
  - `summary`: one sentence, at most about 25 words, describing what the
    customer wanted and how it ended.
  - `feeling`: `happy` | `neutral` | `frustrated`. This is the customer's mood
    by the end of the chat, judged from their own messages.
  - `topics`: one or more values from the fixed question-type list.
  - `unanswered_questions`: short questions (at most about 12 words each, in
    plain wording) that Lily didn't answer: she said she didn't know, couldn't
    help, or sent the customer to support instead of answering. Empty if none.

  Validate the output. Drop any topic that isn't on the list, coerce an unknown
  feeling to `neutral`, and cap list lengths. Write the result plus
  `summarized_at = now()`.
- **Per customer, after their conversations are summarized:** send the
  customer's previous running summary (if any) plus the summaries of
  conversations that changed in this run. Ask for an updated 2–4 sentence
  running summary that describes how their questions and mood have developed.
  Upsert `lily_customer_summaries`.
- If a model call fails, leave `summarized_at` untouched so the next run retries.
  Log the error and move on to the next conversation.
- Needs an `ANTHROPIC_API_KEY` secret on the Lovely project. The Lovely Next.js
  app already holds a key, and whether to reuse it is up to the team.

### 3. Reading it in makeLILA

**`lovely-lily-chats`** edge function. Source goes in
`app/supabase/functions/lovely-lily-chats/` in the makeLILA repo, next to
`lovely-users`. It **deploys to the Lovely project**, with the same header
warning and `verify_jwt = false`. Auth works exactly like `lovely-users`:
validate the caller's makeLILA JWT against makeLILA auth, require an
`@virgohome.io` email, then read with the Lovely service role.

Two actions:
- **list** (default) returns:
  - every customer with at least one conversation: `user_id`, first and last
    name, email, phone, serial, `created_at`, running summary;
  - every conversation's metadata (no messages): `id`, `user_id`, `started_at`,
    `last_message_at`, `message_count`, first user message (truncated),
    `summary`, `feeling`, `topics`, `unanswered_questions`, `summarized_at`.

  The overview strip, sort order, chips and counts are all computed client-side
  from this data. Volume is small (2,000 requests/day global cap), so returning
  everything is fine for v1. Supabase returns at most 1,000 rows per query by
  default, so page through conversations with `.range()` until exhausted.
  Don't assume one query gets them all.
- **transcript** (`conversation_id`) returns that conversation's messages in
  order. It's called when a chat-history row is expanded.

**makeLILA frontend:**
- `app/src/lib/lovelyLilyChats.ts`: types, `useLovelyLilyChats()` hook (direct
  `fetch` with operator token + Lovely anon key as `apikey`, mirroring
  `useLovelyUsers` in `lib/lovely.ts` so error bodies are readable),
  `fetchLilyTranscript(conversationId)`, and **pure functions** for the
  overview, sort order and grouping so they can be unit-tested. Mirror the
  feeling and question-type label lists here.
- `app/src/modules/Lovely/LilyChatsTab.tsx`, registered in
  `Lovely/index.tsx` `TABS` after Firmware. Styles go in `Lovely.module.css`;
  reuse `kpiRow` / `kpi` / `kpiBad` and the existing chip styles.
- Phone fallback: match each Lovely user to a makeLILA customer with the
  existing timeline matching, and use that customer's phone when the Lovely
  phone is empty.
- The tab is read-only, so there are no `logAction()` calls.

### 4. Privacy policy (Lovely repo)

The Lovely app's `content/legal/privacy-policy.md` already covers the in-app
"Ask Lovely" assistant. The "Chatbot messages" paragraph says messages and
limited machine context "are processed to generate a response," and Anthropic
is listed as a processor. That wording implies chats aren't kept, so this
feature **changes what existing users were told**. Amend the "Chatbot messages"
paragraph and the "How we use" list, borrowing language from
`meta-assistant-privacy-policy.md`, to state that:
- conversations with the in-app assistant are **stored** and tied to the
  account;
- they're sent to Anthropic to generate replies and **summaries**, and aren't
  used to train models;
- the summaries include an automated read of **how the customer is feeling**
  and what kinds of questions they ask;
- staff may review conversations and summaries to support the customer and
  improve the assistant;
- they're deleted when the account is deleted.

Bump the effective date and the `privacy_policy` version in `lib/legal.ts`.
That's where the version actually lives: the 2026-09-06 update changed only
this file and added no `consent_documents` row. Consent is recorded only at
signup (`lib/consent.ts` → `recordSignupConsent`). There's no re-acceptance
flow today.

**How existing users are told (Ryan's decision):** update the posted policy
only, as with the 2026-09-06 change. The policy's "Changes to This Policy"
section already says updates are made this way. There's no in-chat notice, no
re-acceptance prompt, and no per-user consent check before saving. Feeling
tagging is a form of profiling, so the team may want whoever handles legal at
VCycene to look over the new wording before it goes live.

The updated policy must be live **before** chat saving ships.

## Rollout order

1. Privacy policy update + version bump in `lib/legal.ts` (posted only; see §4).
2. Lovely migration applied to the Lovely project.
3. Lovely app: client `conversationId` + route saving, deployed.
4. `lily-summarize` deployed and scheduled.
5. `lovely-lily-chats` deployed **to the Lovely project**.
6. makeLILA Lily Chats tab.

Steps 1–4 ship in the Lovely repo; steps 5–6 ship in makeLILA.

## Validation

- **Lovely route tests** (`app/api/guide/chat/route.test.ts`): saves the last
  user message and the assistant's final text; doesn't save the
  machine-context exchange; doesn't re-save earlier history; a
  `conversationId` owned by another user starts a new conversation; a database
  failure during saving still returns the streamed reply.
- **Summarizer tests:** output validation (unknown topic dropped, unknown
  feeling → neutral, caps); a conversation with new messages after
  `summarized_at` is picked up again; a failed model call leaves it for retry.
- **makeLILA lib tests** (`lovelyLilyChats.test.ts`): 30-day windows,
  "frustrated right now" uses the latest summarized conversation, sort order,
  unanswered-question grouping and counts, phone fallback.
- **Function auth:** a non-`@virgohome.io` token or no token gets a 401.
- **End to end:** with a test Lovely account, chat with Lily, then trigger
  `lily-summarize` with the 30-minute threshold lowered for the test. Confirm
  the customer appears in Lily Chats with a summary, feeling, question types,
  phone and email, and an expandable transcript.

## Left to the builder

- Exact column names, indexes and the JSON shape of `lovely-lily-chats`.
- Staging: the Lovely app's staging environment uses its own Supabase project
  (see `schema/migrations/security_fixes_2026_07_09.sql`). Apply the migration
  and deploy both functions there first.
- How `lily-summarize` is scheduled on the Lovely project (pg_cron, or whatever
  triggers `push-cron` today), and its batch size.
- Prompt wording for both summary calls, and whether to use tool use or JSON
  mode for structured output (load the `claude-api` skill).
- Visual details of the tab within the existing Lovely module styles.
- Whether to record which entry point started a conversation (Guide page vs
  Ask Lovely link). Useful but optional.

## Files likely touched

**Lovely repo (`beta-lovelyapp-host`)**
- `schema/migrations/lily_chats_<date>.sql`, `schema/schema.sql`
- `app/api/guide/chat/route.ts` (+ `route.test.ts`)
- `components/guide-chat.tsx` (+ `guide-chat.test.tsx`)
- `supabase/functions/lily-summarize/index.ts` (new)
- `content/legal/privacy-policy.md`, `lib/legal.ts`

**makeLILA repo**
- `app/supabase/functions/lovely-lily-chats/index.ts` (new, deploys to Lovely project)
- `app/src/lib/lovelyLilyChats.ts` (+ `lovelyLilyChats.test.ts`) (new)
- `app/src/modules/Lovely/LilyChatsTab.tsx` (new), `Lovely/index.tsx`, `Lovely/Lovely.module.css`
