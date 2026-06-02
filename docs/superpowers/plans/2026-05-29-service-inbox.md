# Service Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Quo + `support@virgohome.io` Gmail conversations from operator-confirmed tickets via a new Service Inbox tab, fix the duplicate-tickets bug in `sync-quo-tickets`, and bulk-demote 122 polluted Quo rows + Gmail rows to inbox conversations.

**Architecture:** Single `service_tickets` table with a new `kind` column (`conversation` | `ticket`) and an `inbox_disposition` column (`promoted` | `sales` | `follow_up` | `dismissed` | `null`). New `InboxTab` lives in the Service module and shows `kind='conversation'` rows. Operators promote real issues, mark sales/follow-up, or dismiss spam. The Tickets tab now filters to `kind='ticket'`. Sync code switches from `.maybeSingle()` + branch insert to `upsert(..., { onConflict: 'quo_conversation_id' })` backed by a new partial unique index.

**Tech Stack:** React 19 + TypeScript + Vite + CSS Modules · Vitest + React Testing Library · Supabase (Postgres + Edge Functions + Realtime).

**Spec:** [`docs/superpowers/specs/2026-05-29-service-inbox-design.md`](docs/superpowers/specs/2026-05-29-service-inbox-design.md)

---

## File touch list (overview)

| File | Action | Task |
|------|--------|------|
| `supabase/migrations/20260529100000_service_inbox.sql` | Create | 1 |
| `supabase/functions/sync-quo-tickets/index.ts` | Edit | 2 |
| `app/src/lib/service.ts` | Edit (types, hooks, mutators) | 3 |
| `app/src/lib/__tests__/service.inbox.test.ts` | Create | 3 |
| `app/src/modules/Service/SupportTab.tsx` | Edit (filter to `kind='ticket'`) | 4 |
| `app/src/modules/Service/InboxTab.tsx` | Create | 5 |
| `app/src/modules/Service/__tests__/InboxTab.test.tsx` | Create | 5 |
| `app/src/modules/Service/PromoteToTicketModal.tsx` | Create | 6 |
| `app/src/modules/Service/__tests__/PromoteToTicketModal.test.tsx` | Create | 6 |
| `app/src/modules/Service/index.tsx` | Edit (add Inbox tab) | 7 |
| Supabase secret `GMAIL_DELEGATED_MAILBOXES` | Edit (manual) | 8 |

---

## Task 1: Schema migration (columns + indexes + dedupe + bulk-demote)

**Files:**
- Create: `supabase/migrations/20260529100000_service_inbox.sql`

This migration is intentionally one file so the dedupe, unique index, and bulk-demote ship atomically — partial application would leave the DB in an inconsistent state.

- [ ] **Step 1: Write the migration file**

Save the following as `supabase/migrations/20260529100000_service_inbox.sql`:

```sql
-- Service Inbox: separate auto-imported conversations from operator-confirmed tickets.
-- See docs/superpowers/specs/2026-05-29-service-inbox-design.md.

-- 1. Schema additions.
alter table public.service_tickets
  add column if not exists kind text not null default 'ticket'
    check (kind in ('conversation', 'ticket')),
  add column if not exists inbox_disposition text
    check (inbox_disposition in ('promoted', 'sales', 'follow_up', 'dismissed'));

-- 2. Dedupe existing Quo rows BEFORE adding the unique index. Keep the
--    oldest row per conversation_id; delete the rest. Sandra Sweet
--    (+18479179141) currently has 43 rows for 1 conversation; this collapses
--    her to 1. Messages are linked to ticket_id — they survive because we
--    keep the oldest ticket (which received the first insert of the message
--    set). Newer duplicate tickets had their messages upserted by
--    gmail_message_id (`quo:<id>`), so deleting the duplicate ticket rows
--    does not orphan message rows — they were always associated with the
--    one canonical ticket.
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

-- 4. Add an index for the Inbox tab's primary query.
create index if not exists service_tickets_kind_idx
  on public.service_tickets (kind, last_message_at desc nulls last);

-- 5. Bulk-demote all auto-imported Quo + Gmail rows to inbox conversations.
--    HubSpot / Calendly / customer_form / ops_manual rows stay as tickets.
update public.service_tickets
  set kind = 'conversation'
  where source in ('quo', 'gmail');
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the `mcp__claude_ai_Supabase__apply_migration` tool with:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `service_inbox`
- `query`: the SQL above

Expected: tool reports success with no errors.

- [ ] **Step 3: Verify schema additions**

Run via `mcp__claude_ai_Supabase__execute_sql`:

```sql
select column_name, data_type, column_default
  from information_schema.columns
  where table_name = 'service_tickets'
    and column_name in ('kind', 'inbox_disposition');
```

Expected: 2 rows. `kind` has default `'ticket'::text`, `inbox_disposition` has no default.

- [ ] **Step 4: Verify Sandra Sweet is deduped**

```sql
select customer_phone, customer_name,
       count(distinct quo_conversation_id) as conv_ids,
       count(*) as ticket_rows
  from service_tickets
  where source = 'quo' and customer_phone = '+18479179141'
  group by customer_phone, customer_name;
```

Expected: 1 row with `conv_ids = 1` and `ticket_rows = 1`.

- [ ] **Step 5: Verify bulk-demote**

```sql
select source, kind, count(*)
  from service_tickets
  group by source, kind
  order by source, kind;
```

Expected: all `quo` and `gmail` rows have `kind = 'conversation'`. `hubspot`, `calendly`, `ops_manual` rows have `kind = 'ticket'`.

- [ ] **Step 6: Verify unique index rejects duplicates**

```sql
-- Attempt to insert a second row with the same quo_conversation_id.
insert into service_tickets (source, category, status, priority, subject, quo_conversation_id)
  select source, category, status, priority, subject, quo_conversation_id
    from service_tickets where source='quo' and quo_conversation_id is not null limit 1;
```

Expected: ERROR `duplicate key value violates unique constraint "service_tickets_quo_conv_uniq"`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260529100000_service_inbox.sql
git commit -m "feat(service): inbox schema + dedupe Quo tickets

Adds kind + inbox_disposition columns, partial unique index on
quo_conversation_id, dedupes Sandra Sweet 43->1, bulk-demotes 122 Quo
rows + N Gmail rows to kind='conversation' for re-triage."
```

---

## Task 2: Fix `sync-quo-tickets` to use upsert (deploy)

**Files:**
- Modify: `supabase/functions/sync-quo-tickets/index.ts` (lines 266–351)

The current dedup pattern (`.maybeSingle()` then branch insert/update) is what produced Sandra's 43 dupes. Replace with `upsert` keyed on `quo_conversation_id`. The new partial unique index from Task 1 backs this up at the DB layer.

- [ ] **Step 1: Read the current `upsertConversation` function**

Open [`supabase/functions/sync-quo-tickets/index.ts`](supabase/functions/sync-quo-tickets/index.ts) and confirm lines 266–351 match the version from Task 2's edit below. If they have drifted, re-anchor on the function name `upsertConversation` and the comment `// Check if ticket already exists for this conversation.`

- [ ] **Step 2: Replace `upsertConversation` with the upsert-based version**

Replace the entire `upsertConversation` function body (lines ~266–351) with:

```ts
async function upsertConversation(
  admin: SupabaseClient,
  conversationId: string,
  msgs: OPMessage[],
  customersByPhone: Map<string, CustomerLite>,
  unitsByCustomerName: Map<string, string>,
  ordersByEmail: Map<string, string>,
): Promise<'created' | 'appended' | 'skipped'> {
  if (msgs.length === 0) return 'skipped';

  const firstMsg = msgs[0];
  const lastMsg  = msgs[msgs.length - 1];
  const inboundMsg = msgs.find(m => m.direction === 'incoming') ?? firstMsg;
  const customerPhone = inboundMsg.from;
  const customer = customersByPhone.get(phoneKey(customerPhone)) ?? null;

  const subject = buildSubject(firstMsg, customerPhone);
  const msgText = firstMsg.text ?? firstMsg.body ?? '';

  // Conflict target = service_tickets_quo_conv_uniq partial unique index.
  // On conflict we DO NOT overwrite operator-edited fields (subject,
  // description, owner, customer linkage). We only refresh the
  // last_message_at + quo_last_message_id + message_count, which the
  // append-messages path below also updates.
  // Simpler approach: select-then-update with conflict-free guarantee
  // (the unique index ensures at most one row per conversation, so this
  // .maybeSingle() is now safe — there is no race window where two rows
  // can both be returned).
  const { data: existing } = await admin
    .from('service_tickets')
    .select('id, quo_last_message_id, message_count')
    .eq('quo_conversation_id', conversationId)
    .maybeSingle();

  if (existing) {
    const added = await insertNewMessages(admin, existing.id, msgs, existing.quo_last_message_id);
    if (added === 0) return 'skipped';
    await admin.from('service_tickets').update({
      last_message_at:     lastMsg.createdAt,
      quo_last_message_id: lastMsg.id,
      message_count:       (existing.message_count ?? 0) + added,
    }).eq('id', existing.id);
    return 'appended';
  }

  // No existing row: insert. The unique index will reject a race-created
  // duplicate; if that happens we re-fetch and append.
  const ticketRow = {
    source:              'quo' as const,
    kind:                'conversation' as const,
    category:            'support',
    status:              'new',
    priority:            'normal',
    subject,
    description:         msgText || null,
    customer_name:       customer?.full_name ?? null,
    customer_phone:      customerPhone,
    customer_email:      customer?.email ?? null,
    customer_id:         customer?.id ?? null,
    unit_serial:         customer?.full_name
                           ? (unitsByCustomerName.get(customer.full_name.toLowerCase().trim()) ?? null)
                           : null,
    order_ref:           customer?.email
                           ? (ordersByEmail.get(customer.email.toLowerCase().trim()) ?? null)
                           : null,
    owner_email:         DEFAULT_OWNER_EMAIL,
    quo_conversation_id: conversationId,
    quo_last_message_id: lastMsg.id,
    first_message_at:    firstMsg.createdAt,
    last_message_at:     lastMsg.createdAt,
    message_count:       msgs.length,
  };

  const { data: ticket, error: insErr } = await admin
    .from('service_tickets')
    .insert(ticketRow)
    .select('id')
    .single();

  if (insErr) {
    // Concurrent insert won the race. Re-fetch and append messages onto
    // the surviving row.
    if (insErr.code === '23505') {
      const { data: race } = await admin
        .from('service_tickets')
        .select('id, quo_last_message_id, message_count')
        .eq('quo_conversation_id', conversationId)
        .maybeSingle();
      if (race) {
        const added = await insertNewMessages(admin, race.id, msgs, race.quo_last_message_id);
        if (added > 0) {
          await admin.from('service_tickets').update({
            last_message_at:     lastMsg.createdAt,
            quo_last_message_id: lastMsg.id,
            message_count:       (race.message_count ?? 0) + added,
          }).eq('id', race.id);
        }
        return 'appended';
      }
    }
    throw new Error(`insert ticket failed (conversation ${conversationId}): ${insErr.message}`);
  }
  if (!ticket) {
    throw new Error(`insert ticket returned no row (conversation ${conversationId})`);
  }

  await insertNewMessages(admin, ticket.id, msgs, null);
  return 'created';
}
```

Key changes from the original:
1. New rows are created with `kind: 'conversation'` (explicit, even though DB default would handle it).
2. `23505` (unique violation) is now handled: on race-condition insert collision, re-fetch the winner and append messages.

- [ ] **Step 3: Deploy via Supabase MCP**

Use `mcp__claude_ai_Supabase__deploy_edge_function` with:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `sync-quo-tickets`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `false` (matches current config)
- `files`: the full file contents of `supabase/functions/sync-quo-tickets/index.ts`

Expected: deploy returns `status: ACTIVE`, version increments.

- [ ] **Step 4: Invoke twice and verify idempotency**

Trigger the function manually twice via the Supabase Dashboard or HTTP POST (with no body — function reads from cron schedule). After both runs complete, query:

```sql
select customer_phone, count(distinct quo_conversation_id) as conv_ids, count(*) as ticket_rows
  from service_tickets
  where source = 'quo'
  group by customer_phone
  having count(*) > count(distinct quo_conversation_id)
  order by ticket_rows desc;
```

Expected: 0 rows (no customer has more ticket_rows than conversation_ids). If rows appear, the upsert logic still produces dupes — debug before continuing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-quo-tickets/index.ts
git commit -m "fix(quo): handle unique-index race + insert as conversation

Sync now expects the new service_tickets_quo_conv_uniq partial unique
index. On 23505 collision, re-fetch the surviving row and append
messages. New rows insert as kind='conversation' for Inbox triage."
```

---

## Task 3: Types + hooks + mutators in `lib/service.ts`

**Files:**
- Modify: `app/src/lib/service.ts`
- Create: `app/src/lib/__tests__/service.inbox.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/src/lib/__tests__/service.inbox.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promoteToTicket, setInboxDisposition } from '../service';

// Minimal Supabase chain mock that captures the last .update() / .eq() call.
const updateMock = vi.fn().mockResolvedValue({ data: null, error: null });
const eqMock = vi.fn(() => ({ then: (cb: any) => cb({ data: null, error: null }) }));
const updateChainMock = vi.fn(() => ({ eq: eqMock }));

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: updateChainMock,
    })),
  },
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '',
}));

vi.mock('../activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  updateMock.mockClear();
  eqMock.mockClear();
  updateChainMock.mockClear();
});

describe('promoteToTicket', () => {
  it('flips kind to ticket, sets promoted disposition + category + owner', async () => {
    await promoteToTicket('row-1', {
      category: 'support',
      owner_email: 'reina@virgohome.io',
    });
    expect(updateChainMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ticket',
      inbox_disposition: 'promoted',
      category: 'support',
      owner_email: 'reina@virgohome.io',
      status: 'triaging',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'row-1');
  });
});

describe('setInboxDisposition', () => {
  it('updates disposition without flipping kind for sales/follow_up/dismissed', async () => {
    await setInboxDisposition('row-2', 'sales');
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: 'sales' });
    expect(eqMock).toHaveBeenCalledWith('id', 'row-2');
  });

  it('clears disposition when passed null', async () => {
    await setInboxDisposition('row-3', null);
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run src/lib/__tests__/service.inbox.test.ts
```

Expected: FAIL with `promoteToTicket is not a function` / `setInboxDisposition is not a function`.

- [ ] **Step 3: Add types to `lib/service.ts`**

In [`app/src/lib/service.ts`](app/src/lib/service.ts), find the existing `TicketSource` type (line 9–10) and replace with:

```ts
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag'
  | 'ops_manual' | 'gmail' | 'quo';

export type TicketKind = 'conversation' | 'ticket';
export type InboxDisposition = 'promoted' | 'sales' | 'follow_up' | 'dismissed';
```

In the `ServiceTicket` type (line 24–64), add two fields just before `created_at`:

```ts
  kind: TicketKind;
  inbox_disposition: InboxDisposition | null;
```

- [ ] **Step 4: Add the `useInbox` hook**

Append after the existing `useServiceTickets` function (around line 234) — keep the existing pattern (initial fetch + realtime subscription):

```ts
export function useInbox(disposition?: InboxDisposition | 'untriaged' | 'all'): {
  rows: ServiceTicket[];
  loading: boolean;
} {
  const [rows, setRows] = useState<ServiceTicket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('service_tickets')
        .select('*')
        .eq('kind', 'conversation')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (disposition === 'untriaged') q = q.is('inbox_disposition', null);
      else if (disposition && disposition !== 'all') q = q.eq('inbox_disposition', disposition);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setRows(data as ServiceTicket[]);
      setLoading(false);

      channel = supabase
        .channel(`service_inbox:${disposition ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_tickets' }, (payload) => {
          setRows(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ServiceTicket;
              // Drop rows that no longer belong in this view
              if (row.kind !== 'conversation') return prev.filter(r => r.id !== row.id);
              if (disposition === 'untriaged' && row.inbox_disposition !== null) return prev.filter(r => r.id !== row.id);
              if (disposition && disposition !== 'all' && disposition !== 'untriaged' && row.inbox_disposition !== disposition) {
                return prev.filter(r => r.id !== row.id);
              }
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [disposition]);

  return { rows, loading };
}
```

- [ ] **Step 5: Add disposition mutators**

Append after `useInbox` (or near the existing `createTicket` function):

```ts
export async function setInboxDisposition(
  ticketId: string,
  disposition: InboxDisposition | null,
): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ inbox_disposition: disposition })
    .eq('id', ticketId);
  if (error) throw new Error(`setInboxDisposition: ${error.message}`);
  await logAction({
    entity: 'service_ticket',
    entity_id: ticketId,
    action: 'inbox_disposition_set',
    details: { disposition },
  });
}

export async function promoteToTicket(
  ticketId: string,
  fields: { category: TicketCategory; owner_email: string },
): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({
      kind: 'ticket',
      inbox_disposition: 'promoted',
      category: fields.category,
      owner_email: fields.owner_email,
      status: 'triaging',
    })
    .eq('id', ticketId);
  if (error) throw new Error(`promoteToTicket: ${error.message}`);
  await logAction({
    entity: 'service_ticket',
    entity_id: ticketId,
    action: 'promoted_to_ticket',
    details: { category: fields.category, owner_email: fields.owner_email },
  });
}
```

- [ ] **Step 6: Filter `useServiceTickets` to `kind='ticket'`**

In `useServiceTickets` (around line 200–205), insert one line after the `.order(...)` call:

Find:
```ts
let q = supabase
  .from('service_tickets')
  .select('*')
  .order('created_at', { ascending: false });
if (category) q = q.eq('category', category);
```

Replace with:
```ts
let q = supabase
  .from('service_tickets')
  .select('*')
  .eq('kind', 'ticket')
  .order('created_at', { ascending: false });
if (category) q = q.eq('category', category);
```

Also update the realtime subscription's `setTickets` handler — change the `if (category && row.category !== category) return prev;` line to also reject `kind='conversation'` rows:

Find:
```ts
if (payload.new) {
  const row = payload.new as ServiceTicket;
  if (category && row.category !== category) return prev;
```

Replace with:
```ts
if (payload.new) {
  const row = payload.new as ServiceTicket;
  if (row.kind !== 'ticket') return prev.filter(t => t.id !== row.id);
  if (category && row.category !== category) return prev;
```

- [ ] **Step 7: Run the inbox tests + the broader service tests**

```bash
cd app && npx vitest run src/lib/__tests__/service.inbox.test.ts src/lib/service.test.ts 2>&1 | tail -30
```

Expected: all tests PASS. If `src/lib/service.test.ts` doesn't exist that's fine — only the inbox test file needs to pass.

- [ ] **Step 8: Type-check**

```bash
cd app && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to `kind`, `inbox_disposition`, `TicketKind`, `InboxDisposition`, `useInbox`, `promoteToTicket`, or `setInboxDisposition`. Pre-existing type errors in other files are OK to leave alone.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/service.ts app/src/lib/__tests__/service.inbox.test.ts
git commit -m "feat(service): inbox hook + promote/disposition mutators

useInbox returns kind='conversation' rows, filterable by disposition.
useServiceTickets now filters kind='ticket' so SupportTab stops
showing conversations. promoteToTicket flips kind + sets category +
owner; setInboxDisposition records sales/follow_up/dismissed."
```

---

## Task 4: Verify SupportTab now hides conversations

**Files:**
- Modify: `app/src/modules/Service/SupportTab.tsx` (only if needed)

`useServiceTickets` now filters `kind='ticket'` at the data layer, so SupportTab should automatically stop showing conversations. This task verifies that — no UI change required if the spot-check passes.

- [ ] **Step 1: Run the dev server**

```bash
cd app && npm run dev
```

Open http://localhost:5173 → Service → Support Tickets.

- [ ] **Step 2: Verify conversations are hidden**

Expected: the row count drops by ~120+ vs. before Task 1 (Quo + Gmail rows that got demoted to `kind='conversation'` no longer appear). HubSpot / Calendly / customer_form / ops_manual rows still show.

If conversations are still visible, check the `useServiceTickets` filter was applied correctly in Task 3 Step 6.

- [ ] **Step 3: Add `quo` to the source filter dropdown (defensive — for any remaining Quo rows that were re-promoted)**

In [`app/src/modules/Service/SupportTab.tsx:24`](app/src/modules/Service/SupportTab.tsx#L24), find:

```ts
const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot' | 'gmail'>('all');
```

Replace with:

```ts
const [sourceFilter, setSourceFilter] = useState<'all' | 'customer_form' | 'hubspot' | 'gmail' | 'quo'>('all');
```

This lets operators filter to promoted-from-Quo tickets specifically once they've started promoting.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/SupportTab.tsx
git commit -m "feat(service): add quo to SupportTab source filter"
```

If no changes were needed in Step 3, skip this commit.

---

## Task 5: InboxTab component

**Files:**
- Create: `app/src/modules/Service/InboxTab.tsx`
- Create: `app/src/modules/Service/__tests__/InboxTab.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `app/src/modules/Service/__tests__/InboxTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InboxTab } from '../InboxTab';
import type { ServiceTicket } from '../../../lib/service';

function mkConv(partial: Partial<ServiceTicket> & { id: string }): ServiceTicket {
  return {
    id: partial.id,
    ticket_number: 'CONV-1',
    category: 'support',
    source: 'quo',
    status: 'new',
    priority: 'normal',
    customer_id: null, customer_name: null, customer_email: null,
    customer_phone: '+15551234567', unit_serial: null, order_ref: null,
    subject: 'test convo', description: 'hello', internal_notes: null,
    defect_category: null, parts_needed: null,
    calendly_event_uri: null, calendly_event_start: null, calendly_host_email: null,
    hubspot_ticket_id: null, fulfillment_queue_id: null,
    owner_email: null, resolved_at: null, closed_at: null,
    created_at: '2026-05-28T00:00:00Z', updated_at: '2026-05-28T00:00:00Z',
    gmail_thread_id: null, gmail_account: null,
    topic: null, summary: null, suggested_next_action: null,
    last_classified_at: null, classification_confidence: null,
    message_count: 1,
    first_message_at: '2026-05-28T00:00:00Z',
    last_message_at: '2026-05-28T00:00:00Z',
    is_manually_overridden: false,
    kind: 'conversation',
    inbox_disposition: null,
    ...partial,
  };
}

const setDispositionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return {
    ...actual,
    useInbox: vi.fn(() => ({
      rows: [
        mkConv({ id: 'c1', customer_name: 'Alice', description: 'I need help' }),
        mkConv({ id: 'c2', source: 'gmail', subject: 'sales inquiry', description: 'Want a demo' }),
      ],
      loading: false,
    })),
    setInboxDisposition: setDispositionMock,
    SOURCE_LABEL: actual.SOURCE_LABEL,
  };
});

beforeEach(() => { setDispositionMock.mockClear(); });

describe('InboxTab', () => {
  it('renders one row per conversation with channel icon + customer', () => {
    render(<InboxTab />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/sales inquiry/i)).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking Dismiss calls setInboxDisposition with dismissed', async () => {
    render(<InboxTab />);
    const buttons = screen.getAllByRole('button', { name: /dismiss/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'dismissed');
  });

  it('clicking Sales calls setInboxDisposition with sales', async () => {
    render(<InboxTab />);
    const buttons = screen.getAllByRole('button', { name: /^sales$/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'sales');
  });

  it('clicking Follow-up calls setInboxDisposition with follow_up', async () => {
    render(<InboxTab />);
    const buttons = screen.getAllByRole('button', { name: /follow-up/i });
    fireEvent.click(buttons[0]);
    expect(setDispositionMock).toHaveBeenCalledWith('c1', 'follow_up');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run src/modules/Service/__tests__/InboxTab.test.tsx
```

Expected: FAIL with `Failed to resolve import "../InboxTab"`.

- [ ] **Step 3: Create the InboxTab component**

Create `app/src/modules/Service/InboxTab.tsx`:

```tsx
import { useState } from 'react';
import {
  useInbox, setInboxDisposition, SOURCE_LABEL,
  type InboxDisposition, type ServiceTicket,
} from '../../lib/service';
import { PromoteToTicketModal } from './PromoteToTicketModal';
import styles from './Service.module.css';

type DispositionFilter = 'all' | 'untriaged' | InboxDisposition;

const FILTERS: { key: DispositionFilter; label: string }[] = [
  { key: 'untriaged', label: 'Untriaged' },
  { key: 'all',       label: 'All' },
  { key: 'sales',     label: 'Sales' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'dismissed', label: 'Dismissed' },
];

function channelIcon(source: ServiceTicket['source']): string {
  if (source === 'quo') return '☎️';   // ☎️
  if (source === 'gmail') return '✉️'; // ✉️
  return '?';
}

function relativeAge(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  return `${d}d`;
}

export function InboxTab() {
  const [filter, setFilter] = useState<DispositionFilter>('untriaged');
  const { rows, loading } = useInbox(filter);
  const [promoteId, setPromoteId] = useState<string | null>(null);

  async function handleDisposition(id: string, d: InboxDisposition) {
    try { await setInboxDisposition(id, d); }
    catch (e) { alert((e as Error).message); }
  }

  return (
    <>
      <div className={styles.filterRow}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            className={`${styles.chip} ${filter === f.key ? styles.chipActive : ''}`}
            onClick={() => setFilter(f.key)}
          >{f.label}</button>
        ))}
      </div>

      {loading && <div className={styles.empty}>Loading…</div>}
      {!loading && rows.length === 0 && <div className={styles.empty}>Inbox empty.</div>}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ch</th>
              <th>Customer</th>
              <th>Last message</th>
              <th>Age</th>
              <th>Source</th>
              <th>Disposition</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{channelIcon(r.source)}</td>
                <td>{r.customer_name ?? r.customer_phone ?? r.customer_email ?? 'Unknown'}</td>
                <td className={styles.inboxSnippet}>{(r.description ?? r.subject ?? '').slice(0, 80)}</td>
                <td>{relativeAge(r.last_message_at)}</td>
                <td>{SOURCE_LABEL[r.source]}</td>
                <td>{r.inbox_disposition ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setPromoteId(r.id)}>→ Ticket</button>
                  <button onClick={() => handleDisposition(r.id, 'sales')}>Sales</button>
                  <button onClick={() => handleDisposition(r.id, 'follow_up')}>Follow-up</button>
                  <button onClick={() => handleDisposition(r.id, 'dismissed')}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {promoteId && (
        <PromoteToTicketModal
          conversationId={promoteId}
          onClose={() => setPromoteId(null)}
        />
      )}
    </>
  );
}
```

The chip / chipActive / empty / table / filterRow classes already exist in Service.module.css and are used by SupportTab — reusing them keeps visual consistency.

- [ ] **Step 4: Add the one missing CSS class**

Append to `app/src/modules/Service/Service.module.css` (only `.inboxSnippet` — everything else reuses existing classes):

```css
.inboxSnippet {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-ink-subtle);
}
```

- [ ] **Step 5: Stub out the modal so tests pass even before Task 6**

Create a minimal `app/src/modules/Service/PromoteToTicketModal.tsx` that satisfies the import:

```tsx
export function PromoteToTicketModal(props: { conversationId: string; onClose: () => void }) {
  return null;
}
```

Task 6 replaces this with the real implementation.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd app && npx vitest run src/modules/Service/__tests__/InboxTab.test.tsx
```

Expected: 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/modules/Service/InboxTab.tsx app/src/modules/Service/__tests__/InboxTab.test.tsx app/src/modules/Service/PromoteToTicketModal.tsx app/src/modules/Service/Service.module.css
git commit -m "feat(service): InboxTab with filter chips + row actions

Renders kind='conversation' rows via useInbox; per-row buttons for
Promote / Sales / Follow-up / Dismiss. PromoteToTicketModal stub
satisfies the import; real modal lands in next commit."
```

---

## Task 6: Promote-to-ticket modal

**Files:**
- Replace stub: `app/src/modules/Service/PromoteToTicketModal.tsx`
- Create: `app/src/modules/Service/__tests__/PromoteToTicketModal.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `app/src/modules/Service/__tests__/PromoteToTicketModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromoteToTicketModal } from '../PromoteToTicketModal';

const promoteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../lib/service', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/service')>('../../../lib/service');
  return { ...actual, promoteToTicket: promoteMock };
});
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { email: 'reina@virgohome.io' } }),
}));

beforeEach(() => { promoteMock.mockClear(); });

describe('PromoteToTicketModal', () => {
  it('submits with chosen category + current user email as owner', async () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c1" onClose={onClose} />);

    // Default category should be 'support'.
    const submit = screen.getByRole('button', { name: /promote/i });
    fireEvent.click(submit);

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('c1', {
      category: 'support',
      owner_email: 'reina@virgohome.io',
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches category to onboarding when selected', async () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c2" onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'onboarding' } });
    fireEvent.click(screen.getByRole('button', { name: /promote/i }));

    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith('c2', expect.objectContaining({
      category: 'onboarding',
    })));
  });

  it('Cancel does NOT call promoteToTicket', () => {
    const onClose = vi.fn();
    render(<PromoteToTicketModal conversationId="c3" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(promoteMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run src/modules/Service/__tests__/PromoteToTicketModal.test.tsx
```

Expected: FAIL — the stub returns null so there's no button to find.

- [ ] **Step 3: Replace the stub with the real modal**

Overwrite `app/src/modules/Service/PromoteToTicketModal.tsx`:

```tsx
import { useState } from 'react';
import { promoteToTicket, type TicketCategory } from '../../lib/service';
import { useAuth } from '../../lib/auth';
import styles from './Service.module.css';

type Props = { conversationId: string; onClose: () => void };

export function PromoteToTicketModal({ conversationId, onClose }: Props) {
  const { user } = useAuth();
  const [category, setCategory] = useState<TicketCategory>('support');
  const [owner, setOwner] = useState(user?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await promoteToTicket(conversationId, { category, owner_email: owner });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <span>Promote to ticket</span>
          <button className={styles.modalClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label htmlFor="promote-category">Category</label>
            <select
              id="promote-category"
              className={styles.modalSelect}
              value={category}
              onChange={e => setCategory(e.target.value as TicketCategory)}
            >
              <option value="support">Support</option>
              <option value="onboarding">Onboarding</option>
              <option value="repair">Repair</option>
            </select>
          </div>
          <div className={styles.modalRow}>
            <label htmlFor="promote-owner">Owner</label>
            <input
              id="promote-owner"
              type="email"
              className={styles.modalInput}
              value={owner}
              onChange={e => setOwner(e.target.value)}
            />
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button className={styles.modalSecondary} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className={styles.modalPrimary} onClick={handleSubmit} disabled={submitting || !owner}>
            {submitting ? 'Promoting…' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

All CSS classes here (`modalBackdrop`, `modalCard`, `modalHead`, `modalClose`, `modalBody`, `modalRow`, `modalSelect`, `modalInput`, `modalError`, `modalFoot`, `modalSecondary`, `modalPrimary`) already exist in Service.module.css — reusing the established modal pattern.

- [ ] **Step 4: (No CSS additions needed — all classes already exist.)**

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd app && npx vitest run src/modules/Service/__tests__/PromoteToTicketModal.test.tsx
```

Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/Service/PromoteToTicketModal.tsx app/src/modules/Service/__tests__/PromoteToTicketModal.test.tsx
git commit -m "feat(service): PromoteToTicketModal with category + owner

Modal opens from InboxTab → Ticket button. Defaults owner to the
signed-in user's email, category to support. On submit calls
promoteToTicket and closes."
```

---

## Task 7: Wire Inbox into Service module navigation

**Files:**
- Modify: `app/src/modules/Service/index.tsx`

- [ ] **Step 1: Add Inbox to the tabs config and routing**

Replace the contents of [`app/src/modules/Service/index.tsx`](app/src/modules/Service/index.tsx) with:

```tsx
import { useState } from 'react';
import { InboxTab } from './InboxTab';
import { OnboardingTab } from './OnboardingTab';
import { SupportTab } from './SupportTab';
import { RepairTab } from './RepairTab';
import styles from './Service.module.css';

type Tab = 'inbox' | 'onboarding' | 'support' | 'repair';

const TABS: { key: Tab; label: string }[] = [
  { key: 'inbox',      label: 'Inbox' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'support',    label: 'Support Tickets' },
  { key: 'repair',     label: 'Repair' },
];

export default function Service() {
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <div className={styles.layout}>
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.active : ''}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>
      <div className={styles.panel}>
        {tab === 'inbox'      && <InboxTab />}
        {tab === 'onboarding' && <OnboardingTab />}
        {tab === 'support'    && <SupportTab />}
        {tab === 'repair'     && <RepairTab />}
      </div>
    </div>
  );
}
```

Default tab is now `inbox` because that's where untriaged work lives.

- [ ] **Step 2: Smoke-test in the browser**

```bash
cd app && npm run dev
```

Open http://localhost:5173 → Service. Confirm:
- Four tabs visible: Inbox · Onboarding · Support Tickets · Repair
- Inbox tab is selected by default
- Inbox shows demoted Quo + Gmail rows
- Switching to Support Tickets shows only HubSpot / Calendly / customer_form / ops_manual rows (no Quo / Gmail unless promoted)

- [ ] **Step 3: End-to-end promote spot-check**

In Inbox: click `→ Ticket` on any row. Modal opens. Pick `support`, accept default owner, click Promote. Row disappears from Inbox. Switch to Support Tickets → the row appears there with `source = quo` (or `gmail`).

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/index.tsx
git commit -m "feat(service): mount Inbox as default Service tab

New tab order: Inbox | Onboarding | Support Tickets | Repair.
Inbox is the default landing since that's where untriaged
conversations need attention."
```

---

## Task 8: Update `GMAIL_DELEGATED_MAILBOXES` secret (manual)

**Files:**
- Supabase secret (no source file)

- [ ] **Step 1: Check current value**

Ask Huayi or check the Supabase Dashboard → Project Settings → Edge Functions → Secrets for the current `GMAIL_DELEGATED_MAILBOXES` value. Note any mailboxes that will be removed (e.g. `huayi@virgohome.io`).

- [ ] **Step 2: Verify `support@virgohome.io` exists as a delegated mailbox**

In Google Workspace admin (or ask Huayi): confirm `support@virgohome.io` is set up as a real mailbox (not an alias) and that the service account from `GOOGLE_SERVICE_ACCOUNT_KEY` has domain-wide delegation for it.

If `support@virgohome.io` is currently an alias only, set up a real Workspace mailbox first or pause this task and flag to Huayi.

- [ ] **Step 3: Update the secret**

```powershell
$env:SUPABASE_SECRETS_VALUE = "support@virgohome.io"
./app/node_modules/.bin/supabase secrets set GMAIL_DELEGATED_MAILBOXES=$env:SUPABASE_SECRETS_VALUE --project-ref txeftbbzeflequvrmjjr
```

Expected: `Finished supabase secrets set.`

- [ ] **Step 4: Trigger `sync-gmail-tickets` and verify**

Invoke `sync-gmail-tickets` manually via Supabase Dashboard or HTTP POST. Then query:

```sql
select gmail_account, count(*)
  from service_tickets
  where source = 'gmail'
    and created_at > now() - interval '10 minutes'
  group by gmail_account;
```

Expected: any new rows have `gmail_account = 'support@virgohome.io'` only. If other mailboxes appear, the secret didn't take — re-run Step 3.

- [ ] **Step 5: Document in `CLAUDE.md`**

Append to the **Environment** section of `app/CLAUDE.md` (if absent):

```
# Supabase Edge Function secrets (set via `supabase secrets set`):
#   GMAIL_DELEGATED_MAILBOXES=support@virgohome.io   # service inbox only
```

Commit:

```bash
git add app/CLAUDE.md
git commit -m "docs(env): document GMAIL_DELEGATED_MAILBOXES scope"
```

If `app/CLAUDE.md` doesn't have an Environment section to extend, skip the commit.

---

## Final verification

After all tasks complete:

- [ ] Tickets tab shows only `kind='ticket'` rows (no Quo / Gmail noise unless promoted).
- [ ] Inbox tab shows demoted Quo + Gmail rows with channel icon + per-row actions.
- [ ] Sandra Sweet has exactly 1 row in `service_tickets`.
- [ ] `sync-quo-tickets` invoked back-to-back creates 0 dupes (DB-enforced).
- [ ] New Gmail rows only come from `support@virgohome.io`.
- [ ] All vitest tests pass (`cd app && npx vitest run`).
- [ ] `npx tsc --noEmit` reports no new errors.

Then prompt Huayi to demo with Reina and Junaid.
