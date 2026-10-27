# Lily Chat Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save every conversation customers have with Lily in the Lovely app, summarize each one with Claude (recap, feeling, question types, unanswered questions), and show them per customer in a new makeLILA › Lovely › **Lily Chats** tab.

**Architecture:** The Lovely app's chat route saves each exchange through a Postgres function into three new service-role-only tables in the Lovely Supabase project. A cron-scheduled edge function (`lily-summarize`) on that project summarizes quiet conversations with Claude Haiku and keeps a running per-customer summary. makeLILA reads all of it through a new operator-JWT-gated edge function (`lovely-lily-chats`) and computes the overview, sorting and phone fallback client-side in pure, tested functions.

**Tech Stack:** Lovely app: Next.js (App Router), Supabase JS, `@anthropic-ai/sdk`, Vitest, pnpm. Edge functions: Deno on Supabase. makeLILA: React 18 + TypeScript + Vite, CSS Modules, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-25-lily-chat-analytics-design.md` (makeLILA repo). Read it before starting any task.

**Repos:**
- **Lovely** = `c:\Users\ryany\OneDrive\Desktop\beta-lovelyapp-host` (Tasks 1–6)
- **makeLILA** = `c:\Users\ryany\OneDrive\Desktop\makelila` (Tasks 7–9)
- Task 10 spans both.

## Global Constraints

- **Never `git commit`, merge or push.** Ryan commits. Each task ends by listing the files it changed.
- **No migration, function deploy, secret or cron change on the production Lovely project (`arfdopgbvlfmhmcfghhl`) without Ryan's explicit go-ahead in the session.** Lovely-side work goes to the Lovely **staging** Supabase project first (see `schema/migrations/security_fixes_2026_07_09.sql` for which project that is).
- Chat tables are **service-role only**: RLS enabled plus `REVOKE ALL ... FROM authenticated, anon`, like `ai_usage_daily`. Never anon-readable.
- Saving chats **fails open**. It must never block, delay or break the customer's streamed reply.
- Never save the injected `(Context — my machine's current status)` exchange.
- Feelings, verbatim: `happy` "Happy", `neutral` "Neutral", `frustrated` "Frustrated".
- Question types, verbatim, in this order: `what_can_i_compost` "What can I compost", `troubleshooting` "Troubleshooting", `machine_status` "Machine status", `app_help` "App help", `orders_shipping` "Orders & shipping", `other` "Other".
- Summary model: `claude-haiku-5-5`. Quiet period before summarizing: **30 minutes**. Schedule: **every 15 minutes**. Batch: **25** conversations per run.
- Overview windows are **30 days**. Staff = email ending `@virgohome.io`. Staff are excluded from every overview number but still listed, tagged "Staff".
- Phone and email are **plain text** next to the name. No `tel:` or `mailto:` links.
- makeLILA: CSS Modules only, Supabase and fetch access only through `src/lib/`, read-only tab (no `logAction`).
- `lovely-lily-chats` source lives in makeLILA but **deploys to the Lovely project** with `--no-verify-jwt`.
- Test commands. Lovely: `pnpm vitest run <path>`. makeLILA: `cd app && npx vitest run <path>`.

## Review Focus

1. **A customer sends a new message while their conversation is being summarized.** The new message must still get summarized on a later run. `summarized_at` is set to the `last_message_at` value read at selection time, never `now()`. Tested in Task 5 (`summaryUpdate`).
2. **The model call keeps failing for one conversation.** That conversation must not block the batch forever. Failures increment `summary_attempts`, and the selection function skips conversations at 5 or more attempts. Tested in Task 5 (`failureUpdate`) and checked by SQL in Task 2.
3. **A very long conversation.** The transcript sent to the model is capped to the most recent 24,000 characters. Tested in Task 5 (`formatTranscript`).
4. **A customer who chatted less than 30 minutes ago.** They have no summary yet. They appear in the list with "Summary pending", no feeling chip, and are not counted as frustrated. Tested in Tasks 8 and 9.
5. **A customer with no phone in either Lovely or makeLILA.** The profile shows "No phone on file". Tested in Tasks 8 (`resolvePhone`) and 9.

---

### Task 1: Privacy policy discloses stored and summarized chats (Lovely)

**Files:**
- Modify: `content/legal/privacy-policy.md` (effective date line, "Chatbot messages" paragraph at line 22, "How We Use Your Information" list, "Data Retention" section)
- Modify: `lib/legal.ts` (`CURRENT_LEGAL_VERSIONS.privacy_policy`)
- Test: `content/legal/documents.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test** in `content/legal/documents.test.ts`:

```ts
it("privacy policy discloses that in-app assistant chats are stored and summarized", () => {
  const md = read("privacy-policy.md")
  for (const phrase of [
    "we store your conversations with the in-app assistant",
    "summaries",
    "how you are feeling",
    "our team may review",
    "deleted when you delete your account",
  ]) {
    expect(md).toContain(phrase)
  }
  expect(md).not.toContain("processed to generate a response (see")
})
```

- [ ] **Step 2: Run it.** `pnpm vitest run content/legal/documents.test.ts`. Expected: FAIL on the new test only.
- [ ] **Step 3: Edit the policy.** Rewrite the "Chatbot messages" paragraph to cover the five points in spec §4, borrowing tone from `content/legal/meta-assistant-privacy-policy.md`. Use the phrases from the test verbatim. Add bullets to "How We Use Your Information" (support customers, improve the assistant) and a sentence to "Data Retention" (chats kept until the account is deleted). Set `**Effective date:**` and `CURRENT_LEGAL_VERSIONS.privacy_policy` to the ship date (`YYYY-MM-DD` in `lib/legal.ts`, long form in the Markdown). Ask Ryan for the date if it isn't known.
- [ ] **Step 4: Run it.** Same command. Expected: all `legal documents` tests PASS.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 2: Chat tables and database functions (Lovely)

**Files:**
- Create: `schema/migrations/lily_chats_2026_10_25.sql`
- Modify: `schema/schema.sql` (append the same objects after the `ai_usage_daily` block, ~line 783)

**Interfaces:**
- Produces (used by Tasks 3, 6, 7):
  - `lily_conversations(id uuid pk, user_id uuid not null → users(id) on delete cascade, serial_number text, first_user_message text, started_at timestamptz default now(), last_message_at timestamptz default now(), message_count int default 0, summary text, feeling text check in ('happy','neutral','frustrated'), topics text[] default '{}', unanswered_questions text[] default '{}', summarized_at timestamptz, summary_attempts int default 0)`
  - `lily_messages(id bigint generated always as identity pk, conversation_id uuid → lily_conversations(id) on delete cascade, role text check in ('user','assistant'), content text not null, created_at timestamptz default now())`. Order transcripts **by `id`**: both messages of one exchange share `now()`.
  - `lily_customer_summaries(user_id uuid pk → users(id) on delete cascade, summary text not null, updated_at timestamptz default now())`
  - `log_lily_exchange(p_conversation_id uuid, p_user_id uuid, p_serial text, p_user_message text, p_assistant_text text) returns uuid`. Returns the conversation id actually used.
  - `lily_conversations_needing_summary(p_quiet_minutes int, p_limit int) returns setof lily_conversations`

- [ ] **Step 1: Write the migration.** Tables as above. Add `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL ... FROM authenticated, anon` on all three tables. Add indexes on `lily_conversations(user_id, started_at)`, `lily_conversations(last_message_at)` and `lily_messages(conversation_id, id)`. Both functions are `SECURITY DEFINER SET search_path = public`, with `REVOKE EXECUTE ... FROM public, anon, authenticated` and `GRANT EXECUTE ... TO service_role`. `log_lily_exchange` body:

```sql
DECLARE
  v_id    UUID := p_conversation_id;
  v_owner UUID;
  v_added INTEGER := CASE WHEN coalesce(p_assistant_text, '') = '' THEN 1 ELSE 2 END;
BEGIN
  SELECT user_id INTO v_owner FROM lily_conversations WHERE id = v_id FOR UPDATE;
  IF v_owner IS NOT NULL AND v_owner <> p_user_id THEN
    v_id := gen_random_uuid();          -- someone else's id: never append to it
    v_owner := NULL;
  END IF;
  IF v_owner IS NULL THEN
    INSERT INTO lily_conversations (id, user_id, serial_number, first_user_message, message_count)
    VALUES (v_id, p_user_id, p_serial, left(p_user_message, 200), v_added);
  ELSE
    UPDATE lily_conversations
       SET last_message_at  = now(),
           message_count    = message_count + v_added,
           serial_number    = coalesce(p_serial, serial_number),
           summary_attempts = 0          -- new messages get a fresh set of retries
     WHERE id = v_id;
  END IF;
  INSERT INTO lily_messages (conversation_id, role, content) VALUES (v_id, 'user', p_user_message);
  IF v_added = 2 THEN
    INSERT INTO lily_messages (conversation_id, role, content) VALUES (v_id, 'assistant', p_assistant_text);
  END IF;
  RETURN v_id;
END
```

  `lily_conversations_needing_summary` selects rows where `last_message_at < now() - make_interval(mins => p_quiet_minutes)` AND (`summarized_at IS NULL` OR `summarized_at < last_message_at`) AND `summary_attempts < 5`, ordered by `last_message_at` ascending, `LIMIT p_limit`.

- [ ] **Step 2: Mirror into `schema/schema.sql`** with the same section-comment style as `ai_usage_daily`.
- [ ] **Step 3: Apply to the Lovely staging project** (SQL editor or Supabase MCP `apply_migration`, staging ref only). Expected: no errors.
- [ ] **Step 4: Verify on staging with SQL** (pick a real staging `users.id` for `<u1>` and `<u2>`):
  - `SELECT log_lily_exchange('11111111-1111-1111-1111-111111111111', '<u1>', 'LL01-TEST', 'hi', 'hello');` returns `1111…`. `lily_messages` has 2 rows for it, and `message_count = 2`.
  - The same call with `p_user_id = '<u2>'` returns a **different** uuid, and conversation `1111…` still has 2 messages.
  - A call with `p_assistant_text = NULL` adds exactly 1 message.
  - `UPDATE lily_conversations SET last_message_at = now() - interval '1 hour' WHERE id = '1111…';` then `SELECT id FROM lily_conversations_needing_summary(30, 25);` includes it. After `UPDATE ... SET summary_attempts = 5`, it no longer appears.
  - As `anon` (`SET ROLE anon; SELECT * FROM lily_conversations;`) the query errors with permission denied. Then `RESET ROLE`.
  - Delete the test rows.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 3: Chat route saves each exchange (Lovely)

**Files:**
- Create: `lib/chatbot/conversation-log.ts`, `lib/chatbot/conversation-log.test.ts`
- Modify: `app/api/guide/chat/route.ts`, `app/api/guide/chat/route.test.ts`

**Interfaces:**
- Consumes: `log_lily_exchange` RPC (Task 2).
- Produces:
  - `normalizeConversationId(raw: unknown): string`. Returns `raw` if it's a UUID string, otherwise `crypto.randomUUID()`.
  - `logExchange(service: SupabaseClient, args: { conversationId: string; userId: string; serialNum: string; userMessage: string; assistantText: string | null }): Promise<void>`. Calls `service.rpc("log_lily_exchange", { p_conversation_id, p_user_id, p_serial, p_user_message, p_assistant_text })`. **Never throws**: errors (returned or thrown) go to `logError("lily chat log failed", e)`.
  - Request body accepted by the route: `{ conversationId?: string, messages: ChatMessage[] }`.

- [ ] **Step 1: Write the failing unit tests** in `conversation-log.test.ts`:
  - `normalizeConversationId` returns a valid UUID unchanged, and returns a fresh value matching `/^[0-9a-f-]{36}$/` for `undefined`, `"abc"` and `42`.
  - `logExchange` passes exactly `{ p_conversation_id: "c1", p_user_id: "u1", p_serial: "LILA123", p_user_message: "hi", p_assistant_text: "hello" }` to `rpc("log_lily_exchange", …)`.
  - `logExchange` resolves (does not reject) when `rpc` resolves `{ error: { message: "boom" } }` and when `rpc` rejects.
- [ ] **Step 2: Write the failing route tests** in `route.test.ts`. Change `foodGuideSupabaseMock` so `rpc` dispatches on its first argument (`increment_ai_usage` → quota, `log_lily_exchange` → `{ data: "<id>", error: null }`). Add:
  - `saves the newest user message and the streamed reply`: body `{ conversationId: "<uuid>", messages: [u "first", a "answer", u "second"] }`. After `readAll(res)`, expect `rpc` to have been called with `("log_lily_exchange", { p_conversation_id: "<uuid>", p_user_id: "u1", p_serial: "LILA123", p_user_message: "second", p_assistant_text: "Hello there" })`.
  - `never saves the machine-context exchange`: with a snapshot mocked, no `log_lily_exchange` call has a `p_user_message` containing `"(Context"`, and there's exactly one such call.
  - `generates a conversation id when the client sends none`: `p_conversation_id` matches the UUID regex.
  - `still streams the reply when saving fails`: the log RPC rejects. `readAll(res)` equals `"Hello there"` and the status is 200.
  - `saves only the user message when the model fails`: fake stream's `finalMessage` throws before any text. Expect `p_assistant_text: null`. The response still contains the "Sorry, I'm having trouble" fallback, and the fallback is **not** saved.
- [ ] **Step 3: Run both files.** `pnpm vitest run lib/chatbot/conversation-log.test.ts app/api/guide/chat/route.test.ts`. Expected: new tests FAIL, existing ones PASS.
- [ ] **Step 4: Implement `conversation-log.ts`, then change the route.** Read `conversationId` with `normalizeConversationId(body?.conversationId)`. Collect model text in the `ms.on("text")` handler into `replyText`. In the stream's `finally`, call `controller.close()` **first**, then `await logExchange(supabase, { …, userMessage: history[history.length - 1].content, assistantText: replyText || null })`. Leave quota and rate limits unchanged.
- [ ] **Step 5: Run both files.** Same command. Expected: all PASS. Then run `pnpm vitest run`. Expected: no regressions.
- [ ] **Step 6: List changed files for Ryan.**

---

### Task 4: Chat panel sends a conversation id (Lovely)

**Files:**
- Modify: `components/guide-chat.tsx`, `components/guide-chat.test.tsx`

**Interfaces:**
- Consumes: the route body `{ conversationId, messages }` (Task 3).

- [ ] **Step 1: Update and add tests** in `guide-chat.test.tsx`:
  - In the existing `sends the linked question exactly once…` test, change the body assertion to `toEqual({ conversationId: expect.stringMatching(/^[0-9a-f-]{36}$/), messages: [...] })`.
  - New: `uses the same conversation id for every message in a chat`. Send two messages through the input. Both fetch bodies have the same `conversationId`.
  - New: `a fresh mount starts a new conversation id`. Mount, send, unmount, mount again, send. The ids differ.
- [ ] **Step 2: Run it.** `pnpm vitest run components/guide-chat.test.tsx`. Expected: the 3 tests FAIL.
- [ ] **Step 3: Implement.** Add `const conversationIdRef = useRef<string | null>(null)`. In `send`, set it with `crypto.randomUUID()` when it's null, and include it in the JSON body. If jsdom lacks `crypto.randomUUID`, stub it in the test file, not in the component.
- [ ] **Step 4: Run it.** Same command. Expected: all PASS.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 5: Summary logic, pure and tested (Lovely)

**Files:**
- Create: `supabase/functions/lily-summarize/summary.ts`, `supabase/functions/lily-summarize/summary.test.ts`

`summary.ts` must have **no imports** (no Deno globals, no URL imports), so that both Deno (Task 6) and Vitest can load it.

**Interfaces:**
- Produces (used by Task 6):
  - `FEELINGS = ["happy", "neutral", "frustrated"] as const`, `type Feeling`
  - `TOPICS = ["what_can_i_compost", "troubleshooting", "machine_status", "app_help", "orders_shipping", "other"] as const`, `type Topic`
  - `QUIET_MINUTES = 30`, `BATCH_SIZE = 25`, `MAX_TRANSCRIPT_CHARS = 24_000`, `SUMMARY_MODEL = "claude-haiku-5-5"`
  - `type ConversationSummary = { summary: string; feeling: Feeling; topics: Topic[]; unanswered_questions: string[] }`
  - `validateConversationSummary(raw: unknown): ConversationSummary`
  - `formatTranscript(messages: { role: "user" | "assistant"; content: string }[], maxChars?: number): string`
  - `summaryUpdate(conv: { last_message_at: string }, s: ConversationSummary): ConversationSummary & { summarized_at: string; summary_attempts: 0 }`
  - `failureUpdate(conv: { summary_attempts: number }): { summary_attempts: number }`
  - `CONVERSATION_SYSTEM_PROMPT: string`, `CUSTOMER_SYSTEM_PROMPT: string`
  - `SUMMARY_TOOL`: an Anthropic tool definition named `record_summary` whose `input_schema` has the four `ConversationSummary` fields, with `feeling` and `topics` items as enums of `FEELINGS` / `TOPICS`
  - `buildCustomerPrompt(previous: string | null, conversations: { started_at: string; summary: string; feeling: Feeling }[]): string`

- [ ] **Step 1: Write the failing tests** in `summary.test.ts`:
  - `validateConversationSummary`: an unknown feeling (`"angry"`) becomes `"neutral"`; topics `["troubleshooting", "bogus", "troubleshooting"]` become `["troubleshooting"]`; empty or missing topics become `["other"]`; `unanswered_questions` drops non-strings and blank strings, keeps at most 5 items, and cuts each to 120 chars; `summary` is trimmed and cut to 300 chars; non-object input gives `{ summary: "", feeling: "neutral", topics: ["other"], unanswered_questions: [] }`.
  - `formatTranscript`: renders `"Customer: hi\nLily: hello"`. With 3 messages of 10,000 chars each and the default cap, it returns at most 24,000 chars and contains the **last** message, not the first.
  - `summaryUpdate`: `summarized_at` equals the input `last_message_at` exactly (Review Focus 1), and `summary_attempts` is 0.
  - `failureUpdate({ summary_attempts: 2 })` returns `{ summary_attempts: 3 }`.
  - `buildCustomerPrompt(null, [...])` contains each conversation's summary and feeling. With a previous summary, it contains that text too.
- [ ] **Step 2: Run it.** `pnpm vitest run supabase/functions/lily-summarize/summary.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `summary.ts`.**
  - `CONVERSATION_SYSTEM_PROMPT` must state: summarize one customer conversation with Lily, the Lovely composter app's assistant. The summary is one sentence of at most about 25 words, covering what the customer wanted and how it ended. Feeling is judged only from the customer's own messages, as of the end of the chat, and is `neutral` when unclear. Topics come only from the list. Unanswered questions are ones Lily said she didn't know, couldn't help with, or sent to support instead of answering, each at most about 12 words, empty if none. Don't invent details.
  - `CUSTOMER_SYSTEM_PROMPT` must state: update a 2–4 sentence running summary of this customer across all their Lily chats, describing how their questions and mood have developed, from the previous summary plus the new conversation summaries.
- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 6: `lily-summarize` edge function (Lovely)

**Files:**
- Create: `supabase/functions/lily-summarize/index.ts`

**Interfaces:**
- Consumes: everything from Task 5 (`import … from "./summary.ts"`); `lily_conversations_needing_summary`, `lily_messages`, `lily_customer_summaries` (Task 2).
- Auth: `Authorization: Bearer ${CRON_SECRET}`, the same check as `supabase/functions/push-cron/index.ts:204-210`. Secrets: `ANTHROPIC_API_KEY`, `CRON_SECRET`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

- [ ] **Step 1: Implement `index.ts`.** Load the `claude-api` skill first. Steps:
  1. Call `rpc("lily_conversations_needing_summary", { p_quiet_minutes: QUIET_MINUTES, p_limit: BATCH_SIZE })`.
  2. For each conversation: load its messages ordered by `id`, then call `messages.create` with model `SUMMARY_MODEL`, `system: CONVERSATION_SYSTEM_PROMPT`, `tools: [SUMMARY_TOOL]`, `tool_choice: { type: "tool", name: "record_summary" }`, and one user message containing `formatTranscript(...)`. Pass the tool input through `validateConversationSummary`, then `update` the row with `summaryUpdate(conv, s)`. On any error, `update` with `failureUpdate(conv)`, `console.error`, and continue.
  3. Group the successful conversations by `user_id`. For each user, read the existing `lily_customer_summaries.summary`, call the model with `CUSTOMER_SYSTEM_PROMPT` + `buildCustomerPrompt(previous, those conversations)` (plain text reply), and `upsert` `{ user_id, summary, updated_at: now }`. On error, log and continue.
  4. Return JSON `{ processed, failed, customersUpdated }`.

  Import the SDK as `npm:@anthropic-ai/sdk` and Supabase as `https://esm.sh/@supabase/supabase-js@2`, matching `push-cron`.
- [ ] **Step 2: Type-check.** `deno check supabase/functions/lily-summarize/index.ts`. Expected: no errors. If Deno isn't installed, run `pnpm exec tsc --noEmit -p .` and confirm no new errors in this folder.
- [ ] **Step 3: Deploy to the Lovely staging project.** `supabase functions deploy lily-summarize --project-ref <staging-ref> --no-verify-jwt`. Set the `ANTHROPIC_API_KEY` secret (and `CRON_SECRET` if it isn't already set). Expected: deploy succeeds.
- [ ] **Step 4: Verify on staging.** Using a staging test account, chat with Lily on staging (Task 3 and 4 code deployed to staging), or insert via `log_lily_exchange`. Backdate `last_message_at` by 1 hour, then `curl -X POST https://<staging-ref>.supabase.co/functions/v1/lily-summarize -H "Authorization: Bearer $CRON_SECRET"`. Expected: `{"processed":1,"failed":0,"customersUpdated":1}`. The row has `summary`, `feeling`, `topics` and `summarized_at = last_message_at`, and `lily_customer_summaries` has a row. A request without the header gets 401.
- [ ] **Step 5: Schedule on staging** every 15 minutes, the same way `push-cron` is scheduled on that project (check Supabase dashboard → Integrations → Cron for the existing job and copy its shape). Expected: the job is listed, and the next run's logs show `processed` ≥ 0 with no errors.
- [ ] **Step 6: List changed files for Ryan.**

---

### Task 7: `lovely-lily-chats` read function (makeLILA)

**Files:**
- Create: `app/supabase/functions/lovely-lily-chats/index.ts`

**Interfaces:**
- Consumes: Task 2 tables and the Lovely `users` table.
- Produces (used by Task 8). `POST` body `{ action?: "list" | "transcript"; conversation_id?: string }`:
  - `list` (default) returns `{ customers: LilyCustomer[]; conversations: LilyConversation[] }`, where
    - `LilyCustomer = { user_id, first_name, last_name, email, phone_number, serial_number, created_at, summary: string | null }`, one per user with at least one conversation;
    - `LilyConversation = { id, user_id, started_at, last_message_at, message_count, first_user_message, summary, feeling, topics, unanswered_questions, summarized_at }`.
  - `transcript` returns `{ messages: { role: "user" | "assistant"; content: string; created_at: string }[] }`, ordered by `id`. Without a `conversation_id` it returns 400.
- Auth: identical to `app/supabase/functions/lovely-users/index.ts`: makeLILA JWT validated against makeLILA auth, `@virgohome.io` only, 401 otherwise. Same header comment warning that it deploys to the **Lovely** project with `verify_jwt = false`.

- [ ] **Step 1: Implement.** Copy the auth and CORS block from `lovely-users`. Page through `lily_conversations` with `.range(from, from + 999)` until a page returns fewer than 1,000 rows. Load `users` and `lily_customer_summaries` for the distinct `user_id`s, chunking `.in()` at 200 ids.
- [ ] **Step 2: Type-check.** `deno check app/supabase/functions/lovely-lily-chats/index.ts`. Expected: no errors.
- [ ] **Step 3: Deploy to the Lovely staging project**, which already has the Task 2 tables. Production waits for Task 10 Step 5, because the tables don't exist there yet. `supabase functions deploy lovely-lily-chats --project-ref <staging-ref> --no-verify-jwt`. The function still validates tokens against makeLILA auth, so a real makeLILA operator token works against staging.
- [ ] **Step 4: Verify on staging.**
  - `curl -X POST https://<staging-ref>.supabase.co/functions/v1/lovely-lily-chats -H "apikey: <staging anon>" -H "Content-Type: application/json" -d '{}'` returns 401.
  - The same call with `Authorization: Bearer <makeLILA operator access token>` returns 200 with the Task 6 test conversation in `conversations` and its user in `customers`, `summary` filled in.
  - `{"action":"transcript","conversation_id":"<that id>"}` returns its messages in order. `{"action":"transcript"}` returns 400.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 8: Data layer and pure analytics (makeLILA)

**Files:**
- Create: `app/src/lib/lovelyLilyChats.ts`, `app/src/lib/lovelyLilyChats.test.ts`

**Interfaces:**
- Consumes: the Task 7 response shapes. `TELEMETRY_URL` and `TELEMETRY_ANON_KEY` from `./supabaseTelemetry`, and `supabase.auth.getSession()` from `./supabase` (mirror `useLovelyUsers` in `lib/lovely.ts`). The types `Customer` (`lib/customers.ts`), `Unit` (`lib/stock.ts`) and `AppLinkRow` (`lib/customerTimeline.ts`).
- Produces (used by Task 9):
  - Types `Feeling`, `Topic`, `LilyCustomer`, `LilyConversation`, `LilyMessage` (as Task 7)
  - `FEELING_LABELS: Record<Feeling, string>`, `TOPIC_LABELS: Record<Topic, string>`, `TOPIC_ORDER: Topic[]` (values from Global Constraints)
  - `useLovelyLilyChats(): { customers: LilyCustomer[]; conversations: LilyConversation[]; loading: boolean; error: string | null; refetch: () => Promise<void> }`
  - `fetchLilyTranscript(conversationId: string): Promise<LilyMessage[]>`
  - `isStaffEmail(email: string | null): boolean`
  - `type LilyProfile = { customer: LilyCustomer; conversations: LilyConversation[] /* newest first */; chatCount: number; lastChatAt: string; latestFeeling: Feeling | null; feelingTrail: Feeling[] /* oldest→newest, summarized only */; topicCounts: { topic: Topic; count: number }[]; frustratedNow: boolean; isStaff: boolean }`
  - `buildProfiles(customers: LilyCustomer[], conversations: LilyConversation[], now: Date): LilyProfile[]`. Sorted with `frustratedNow` first, then `lastChatAt` descending.
  - `type LilyOverview = { chats30d: number; customers30d: number; frustratedNow: number; unanswered30d: number; topicCounts: { topic: Topic; count: number }[]; unanswered: { question: string; count: number }[] }`
  - `buildOverview(profiles: LilyProfile[], now: Date): LilyOverview`. Staff excluded.
  - `matchesSearch(p: LilyProfile, q: string): boolean`. Matches name, email or serial, case-insensitively.
  - `resolvePhone(c: LilyCustomer, ctx: { appLinks: AppLinkRow[]; units: Unit[]; customers: Customer[] }): string | null`

**Definitions** (from spec "What the team sees"):
- `chatCount`: all of the customer's conversations, with no time window. `lastChatAt`: the latest `last_message_at` among them.
- `chats30d`: conversations whose `started_at` is in the last 30 days.
- `customers30d`: distinct users among those conversations.
- `frustratedNow` (per profile): the summarized conversation with the latest `last_message_at` has `feeling === "frustrated"` AND that `last_message_at` is within 30 days.
- `unanswered30d`: total `unanswered_questions` entries on conversations with `last_message_at` in the last 30 days.
- `unanswered`: those entries grouped by `trim().toLowerCase()`, showing the first-seen original wording, sorted by count descending.
- `topicCounts`: conversations in the window per topic, sorted by count descending, ties in `TOPIC_ORDER`.
- `resolvePhone` order: the Lovely `phone_number`, then the makeLILA customer matched by app link (`lovely_user_id`), then by unit serial (trimmed, uppercased), then by email (trimmed, lowercased). This is the same order as `buildTimelines` in `customerTimeline.ts:349-366`. Returns null if none of them has a phone.

- [ ] **Step 1: Write the failing tests** in `lovelyLilyChats.test.ts`, using `lib/lovely.test.ts`'s fetch and session mocking. Fix `NOW = new Date("2026-10-25T12:00:00Z")`:
  - The hook POSTs to `https://lovely.supabase.co/functions/v1/lovely-lily-chats` with `apikey: "lovely-anon"`, `Authorization: "Bearer tok"` and body `{"action":"list"}`. On a 401 `{error:"Unauthorized"}` response, `error` contains `401` and `Unauthorized`.
  - `fetchLilyTranscript("c1")` sends `{"action":"transcript","conversation_id":"c1"}` and returns `messages`.
  - `buildProfiles`: a customer whose latest summarized chat is frustrated (5 days ago) sorts before a happy customer who chatted 1 hour ago. A customer whose latest summarized chat was frustrated 40 days ago has `frustratedNow: false`. A customer with only an unsummarized chat has `latestFeeling: null`, `feelingTrail: []` and `frustratedNow: false` (Review Focus 4). `feelingTrail` is oldest→newest.
  - `buildOverview`: a 31-day-old conversation is excluded from `chats30d`. A frustrated `@virgohome.io` customer is excluded from `frustratedNow`, `chats30d` and `topicCounts`. `"How much compost per week?"` ×2 and `"how much compost per week? "` ×1 group into one entry with `count: 3`.
  - `resolvePhone`: the Lovely phone wins. Without it, the app-link customer's phone is used. Without an app link, the serial match is used (`" ll01-0412 "` matches unit `"LL01-0412"`). Then email. With no match or all phones empty, it returns `null` (Review Focus 5).
  - `matchesSearch` matches on `"ll01"` (serial), `"dana"` (first name) and `"@example"` (email).
- [ ] **Step 2: Run it.** `cd app && npx vitest run src/lib/lovelyLilyChats.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `lovelyLilyChats.ts`.** The hook mirrors `useLovelyUsers` (direct `fetch`, readable error body, `isTelemetryConfigured` guard).
- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: List changed files for Ryan.**

---

### Task 9: Lily Chats tab (makeLILA)

**Files:**
- Create: `app/src/modules/Lovely/LilyChatsTab.tsx`, `app/src/modules/Lovely/LilyChatsTab.test.tsx`
- Modify: `app/src/modules/Lovely/index.tsx` (`Tab` union, `TABS` after `firmware`, render branch), `app/src/modules/Lovely/Lovely.module.css`

**Interfaces:**
- Consumes: everything Task 8 produces, plus `useCustomers` (`lib/customers.ts`), `useUnits` (`lib/stock.ts`) and `useCustomerAppLinks` (`lib/customerTimeline.ts`) for `resolvePhone`.
- Produces: `export function LilyChatsTab(): JSX.Element`. Tab key `'lily'`, label `'Lily Chats'`.

Layout follows spec "What the team sees" and the approved mockup (`.superpowers/brainstorm/1723-1792961750/content/lily-chats-overview-v3.html`, local only):
- **Number row:** reuse `kpiRow` / `kpi` / `kpiLabel` / `kpiValue`, with `kpiBad` on "Frustrated right now" when it's above 0. The four labels: "Chats (30 days)", "Customers chatting", "Frustrated right now", "Lily couldn't answer".
- **Two panels:** "Most asked about (30 days)" (bars) and "Questions Lily couldn't answer" (top 3 with "asked N×", plus a "+ N more" toggle).
- **Left:** a `searchInput` and the profile list (name, feeling chip or nothing, "N chats · last <date>", a "Staff" tag for staff).
- **Right:** the selected profile. The first profile is selected by default.
  - The name, then `"<phone> · <email>"` as plain text, using "No phone on file" when `resolvePhone` returns null.
  - "Serial <serial> · Lovely user since <Mon D>".
  - "Summary across all chats" (or "Summary pending").
  - "How they're feeling" trail.
  - "What they ask about" chips with counts.
  - "Chat history" rows (date, `first_user_message`, `summary`). Clicking a row calls `fetchLilyTranscript` and shows the messages labelled "Customer" / "Lily".
- **Empty state** (no conversations): "No Lily conversations yet. Chats are saved from <ship date> onward."
- Feeling chips get three new classes (`feelingHappy`, `feelingNeutral`, `feelingFrustrated`) in `Lovely.module.css`. Reuse `chip` for topics.

- [ ] **Step 1: Write the failing tests** in `LilyChatsTab.test.tsx`, mocking `useLovelyLilyChats`, `fetchLilyTranscript`, `useCustomers`, `useUnits` and `useCustomerAppLinks` in the `OnboardingTab.test.tsx` style:
  - It renders the four number labels with values computed from the fixture (for example "Frustrated right now" = 1).
  - The frustrated customer is the first list item and is selected. Their phone and email are visible as text, and `container.querySelector('a[href^="tel:"], a[href^="mailto:"]')` is null.
  - A customer with no phone anywhere shows "No phone on file".
  - A customer with only an unsummarized chat shows "Summary pending" and no feeling chip.
  - Clicking a chat-history row calls `fetchLilyTranscript` with that conversation id and renders "Customer" and "Lily" lines.
  - Typing `"ll01-0388"` into search leaves only that customer in the list.
  - With empty data it shows "No Lily conversations yet."
- [ ] **Step 2: Run it.** `cd app && npx vitest run src/modules/Lovely/LilyChatsTab.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `LilyChatsTab.tsx`, the CSS additions and the `index.tsx` registration.
- [ ] **Step 4: Run it.** Same command. Expected: PASS. Then run `cd app && npx vitest run src/modules/Lovely src/lib/lovelyLilyChats.test.ts`. Expected: all PASS. Then `cd app && npm run build`. Expected: build succeeds with no type errors.
- [ ] **Step 5: Look at it.** `cd app && npm run dev`, open Lovely › Lily Chats, and confirm the layout matches the mockup with the empty state (or with data, after Task 10). Use the `run` skill if available.
- [ ] **Step 6: List changed files for Ryan.**

---

### Task 10: Production rollout and end-to-end check (both repos)

Every step here is outward-facing. **Get Ryan's explicit go-ahead before each one.** Follow the spec's rollout order.

- [ ] **Step 1:** Ship the Task 1 policy change with the Lovely app's normal deploy. Expected: `/privacy` (or wherever the app renders the policy) shows the new effective date and paragraph.
- [ ] **Step 2:** Apply `schema/migrations/lily_chats_2026_10_25.sql` to `arfdopgbvlfmhmcfghhl`. Expected: the Task 2 Step 4 SQL checks pass on production (using a staff test account; delete the test rows afterwards).
- [ ] **Step 3:** Deploy the Lovely app with Tasks 3–4. Expected: chatting with Lily on production as a staff test account creates `lily_conversations` and `lily_messages` rows, and Lily still answers normally.
- [ ] **Step 4:** Deploy `lily-summarize` to production, set its secrets, and schedule it every 15 minutes. Expected: within 45 minutes of the test chat, the row has a summary and the customer summary exists.
- [ ] **Step 5:** Deploy `lovely-lily-chats` to production (`supabase functions deploy lovely-lily-chats --project-ref arfdopgbvlfmhmcfghhl --no-verify-jwt`) and re-run the Task 7 Step 4 curl checks against it. Then ship the makeLILA frontend through its normal GitHub Pages deploy. Expected: Lovely › Lily Chats shows the staff test account tagged "Staff" with its summary, feeling, topics, phone and email, and an expandable transcript. The staff account is not counted in the number row.
- [ ] **Step 6:** Tell Ryan what shipped, list every changed file in both repos, and note the open item from the spec: whoever handles legal at VCycene may want to review the new policy wording (feeling tagging is a form of profiling).
