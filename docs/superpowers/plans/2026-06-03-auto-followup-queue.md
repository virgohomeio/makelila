# Auto Follow-up Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an "Overdue follow-ups" panel in the Customers tab that drafts a personalized SMS per overdue customer via Claude, lets Reina review/edit/approve each, and sends through OpenPhone (Quo). Drops Reina's per-message touch time from ~3min to ~15s while preserving her voice and skipping the high-risk cases automatically.

**Architecture:** Two new Deno/Supabase edge functions (`generate-followup-drafts` for LLM drafting, `send-followup-sms` for OpenPhone send + DB side-effects) wrapped in a new React component `OverdueFollowupPanel.tsx` mounted at the top of the Customers tab. No new DB tables — drafts are transient in React state. Auto-skip rules eliminate the riskiest sends (no phone, active return/refund, recently messaged) before they reach Claude or the operator.

**Tech Stack:** Supabase edge functions (Deno + TypeScript) · `claude-haiku-4-5` via the Anthropic Messages API · OpenPhone `/v1/messages` REST API · React 19 + CSS Modules · Vitest + React Testing Library.

**Spec:** [`docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md`](docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md)

**Sequencing note:** The security pass spec ([`6b1cf24`](docs/superpowers/specs/2026-06-03-security-pass-design.md)) isn't shipped yet. Both new edge functions in this plan ship with a **temporary inline auth check** (verify the user JWT + check `profiles.is_internal`). Once the security pass lands, swap each one to the shared `_shared/auth.ts` wrapper — flagged in Task 1 Step 4 and Task 2 Step 4 for replacement.

---

## File touch list

| File | Action | Task |
|------|--------|------|
| `supabase/functions/generate-followup-drafts/index.ts` | Create | T1 |
| `supabase/functions/send-followup-sms/index.ts` | Create | T2 |
| `app/src/lib/customers.ts` | Edit — add `generateFollowupDrafts()` + `sendFollowupSms()` client wrappers | T3 |
| `app/src/modules/Customers/OverdueFollowupPanel.tsx` | Create | T3 |
| `app/src/modules/Customers/Customers.module.css` | Edit — add `.followupPanel` / `.draftCard` styles | T3 |
| `app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx` | Create | T3 |
| `app/src/modules/Customers/index.tsx` | Edit — mount the panel above the existing filter row | T3 |
| Supabase secrets (already set, reused): `ANTHROPIC_API_KEY`, `OPENPHONE_API_KEY`, `OPENPHONE_PHONE_NUMBER_IDS` | — | — |
| Supabase secret `FOLLOWUP_SMS_TEST_PHONE` | Manual: set during testing, unset for go-live | T2 (verification step) |

---

## Task 1: `generate-followup-drafts` edge function

**Files:**
- Create: `supabase/functions/generate-followup-drafts/index.ts`

This function gathers a per-customer context bundle, applies the auto-skip rules, then calls Claude to draft a personalized SMS for the rest. Returns an array — no side effects beyond Anthropic API spend.

- [ ] **Step 1: Create the file**

Save the following as `supabase/functions/generate-followup-drafts/index.ts`:

```ts
// Auto follow-up queue Phase 1: generate Claude-drafted SMS messages
// for a list of overdue customers. See
// docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md.
//
// Auth: operator JWT required. TEMPORARY inline auth check — replace
// with _shared/auth.ts authenticate() once the security pass ships.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Input = { customer_ids?: string[] };
type FuKind = 'fu1' | 'fu2';
type Draft = {
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  days_overdue: number;
  fu_kind: FuKind;
  draft_message: string | null;
  skip_reason: string | null;
  context_summary: string;
};

const FU1_DAYS = 7;
const FU2_DAYS = 30;
const RECENT_TOUCH_DAYS = 7;
const MAX_QUO_MESSAGES = 20;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL / SERVICE_ROLE_KEY' }, 500);
    if (!anthropicKey) return j({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    const admin = createClient(supabaseUrl, serviceKey);

    // ── TEMPORARY inline auth — replace with _shared/auth.ts once
    // the security pass lands.
    const authz = req.headers.get('authorization') ?? '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    if (!jwt) return j({ error: 'Missing Authorization header' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return j({ error: 'Invalid token' }, 401);
    const { data: profile } = await admin.from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
    if (!profile?.is_internal) return j({ error: 'Not authorized' }, 403);

    const { customer_ids } = (await req.json()) as Input;

    // 1. Resolve the customer list.
    let ids = customer_ids ?? [];
    if (ids.length === 0) {
      const { data: overdueRows } = await admin
        .from('customers')
        .select('id')
        .not('onboard_date', 'is', null);
      // Postgres doesn't expose the FU calculation easily here; fetch all
      // overdue-candidates and filter client-side. The full customer list
      // is small (~300) so this is fine.
      const { data: allCustomers } = await admin
        .from('customers')
        .select('id, onboard_date, fu1_status, fu2_status')
        .not('onboard_date', 'is', null);
      const today = new Date();
      ids = (allCustomers ?? []).filter(c => {
        const onboard = new Date(c.onboard_date + 'T00:00:00');
        const fu1Due = new Date(onboard); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
        const fu2Due = new Date(onboard); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
        if (!c.fu1_status && today > fu1Due) return true;
        if (c.fu1_status && !c.fu2_status && today > fu2Due) return true;
        return false;
      }).map(c => c.id);
      void overdueRows;
    }

    if (ids.length === 0) return j({ drafts: [] });

    // 2. Build per-customer drafts (serialized; ~10s for 10 customers is fine).
    const drafts: Draft[] = [];
    for (const id of ids) {
      const draft = await buildDraftForCustomer(admin, anthropicKey, id);
      if (draft) drafts.push(draft);
    }
    return j({ drafts });
  } catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function buildDraftForCustomer(
  admin: SupabaseClient,
  anthropicKey: string,
  customerId: string,
): Promise<Draft | null> {
  // ── Profile ──────────────────────────────────────────────────────
  const { data: c } = await admin
    .from('customers')
    .select('id, full_name, first_name, email, phone, onboard_date, fu1_status, fu2_status, fu_notes')
    .eq('id', customerId)
    .maybeSingle();
  if (!c) return null;

  const onboardDate = c.onboard_date ? new Date(c.onboard_date + 'T00:00:00') : null;
  const today = new Date();
  let fuKind: FuKind | null = null;
  let daysOverdue = 0;
  if (onboardDate) {
    const fu1Due = new Date(onboardDate); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
    const fu2Due = new Date(onboardDate); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
    if (!c.fu1_status && today > fu1Due) {
      fuKind = 'fu1';
      daysOverdue = Math.floor((today.getTime() - fu1Due.getTime()) / 86400_000);
    } else if (c.fu1_status && !c.fu2_status && today > fu2Due) {
      fuKind = 'fu2';
      daysOverdue = Math.floor((today.getTime() - fu2Due.getTime()) / 86400_000);
    }
  }
  if (!fuKind) return null; // Not overdue.

  const baseDraft: Draft = {
    customer_id: c.id,
    customer_name: c.full_name ?? c.first_name ?? '(unknown)',
    customer_phone: c.phone,
    days_overdue: daysOverdue,
    fu_kind: fuKind,
    draft_message: null,
    skip_reason: null,
    context_summary: '',
  };

  // ── Auto-skip: no phone ───────────────────────────────────────────
  if (!c.phone) {
    return { ...baseDraft, skip_reason: 'No phone on file', context_summary: 'No phone on file' };
  }

  // ── Auto-skip: active return / refund / cancellation ──────────────
  const { data: activeReturn } = await admin
    .from('returns')
    .select('return_ref, status')
    .eq('customer_email', c.email)
    .in('status', ['created','in_transit','received','inspecting'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeReturn) {
    return {
      ...baseDraft,
      skip_reason: `Active return ${activeReturn.return_ref} (${activeReturn.status}) — manual touch only`,
      context_summary: `Active return ${activeReturn.return_ref}`,
    };
  }

  const { data: activeApproval } = await admin
    .from('refund_approvals')
    .select('id, status')
    .eq('customer_email', c.email)
    .in('status', ['manager_review','finance_review','approved'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeApproval) {
    return {
      ...baseDraft,
      skip_reason: `Active refund approval (${activeApproval.status}) — manual touch only`,
      context_summary: `Active refund approval`,
    };
  }

  const { data: activeCancel } = await admin
    .from('order_cancellations')
    .select('id')
    .eq('customer_email', c.email)
    .eq('status', 'submitted')
    .limit(1)
    .maybeSingle();
  if (activeCancel) {
    return {
      ...baseDraft,
      skip_reason: 'Active cancellation request — manual touch only',
      context_summary: 'Active cancellation',
    };
  }

  // ── Auto-skip: outbound Quo message within last 7 days ────────────
  const recentCutoff = new Date(Date.now() - RECENT_TOUCH_DAYS * 86400_000).toISOString();
  const { data: recentOut } = await admin
    .from('ticket_messages')
    .select('sent_at, service_tickets!inner(customer_id, source)')
    .eq('direction', 'outbound')
    .eq('service_tickets.customer_id', c.id)
    .eq('service_tickets.source', 'quo')
    .gte('sent_at', recentCutoff)
    .order('sent_at', { ascending: false })
    .limit(1);
  if (recentOut && recentOut.length > 0) {
    return {
      ...baseDraft,
      skip_reason: `Already messaged via Quo on ${recentOut[0].sent_at?.slice(0,10) ?? 'recently'}`,
      context_summary: 'Recently messaged',
    };
  }

  // ── Order ─────────────────────────────────────────────────────────
  const { data: orderRow } = c.email
    ? await admin.from('orders').select('order_ref, placed_at, country').eq('customer_email', c.email).order('placed_at', { ascending: false }).limit(1).maybeSingle()
    : { data: null };

  // ── Unit ──────────────────────────────────────────────────────────
  const { data: unitRow } = c.full_name
    ? await admin.from('units').select('serial, batch, shipped_at').ilike('customer_name', c.full_name).order('shipped_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    : { data: null };

  // ── Quo history (last 20 messages, chronological) ────────────────
  const { data: quoMsgs } = await admin
    .from('ticket_messages')
    .select('direction, body_text, sent_at, service_tickets!inner(customer_id, source)')
    .eq('service_tickets.customer_id', c.id)
    .eq('service_tickets.source', 'quo')
    .order('sent_at', { ascending: false })
    .limit(MAX_QUO_MESSAGES);
  const history = (quoMsgs ?? []).slice().reverse(); // chronological

  // ── Compose context + call Claude ─────────────────────────────────
  const firstName = c.first_name ?? (c.full_name ?? '').split(' ')[0] ?? 'there';
  const contextSummary = [
    unitRow ? `shipped ${unitRow.shipped_at?.slice(0,10) ?? '?'} (${unitRow.batch})` : null,
    history.length > 0 ? `${history.length} Quo msgs (last ${history[history.length-1].sent_at?.slice(0,10)})` : 'no Quo history',
  ].filter(Boolean).join(', ');

  const prompt = composePrompt({
    firstName,
    fullName: c.full_name ?? firstName,
    fuKind,
    daysOverdue,
    onboardDate: c.onboard_date ?? '?',
    unitSerial: unitRow?.serial ?? null,
    unitBatch: unitRow?.batch ?? null,
    orderRef: orderRow?.order_ref ?? null,
    activitySummary: '(none)',
    quoHistory: history.map(m => `${m.direction} ${m.sent_at?.slice(0,10) ?? '?'}: ${(m.body_text ?? '').slice(0, 200)}`).join('\n'),
  });

  try {
    const llmOut = await callClaude(anthropicKey, prompt);
    return {
      ...baseDraft,
      draft_message: llmOut.draft,
      skip_reason: llmOut.skip_reason,
      context_summary: contextSummary,
    };
  } catch (e) {
    return {
      ...baseDraft,
      skip_reason: `LLM error: ${(e as Error).message}`,
      context_summary: contextSummary,
    };
  }
}

function composePrompt(args: {
  firstName: string;
  fullName: string;
  fuKind: FuKind;
  daysOverdue: number;
  onboardDate: string;
  unitSerial: string | null;
  unitBatch: string | null;
  orderRef: string | null;
  activitySummary: string;
  quoHistory: string;
}): string {
  return `You are drafting a short SMS follow-up from Reina at VCycene (the company
that makes the Lila Pro composter). The customer is overdue for a
${args.fuKind === 'fu1' ? 'first (1-week)' : 'second (1-month)'} check-in.

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
- Name: ${args.fullName}
- Onboarded: ${args.onboardDate} (${args.daysOverdue} days past the ${args.fuKind.toUpperCase()} window)
- Unit: ${args.unitSerial ?? '(no serial linked)'} (${args.unitBatch ?? '?'})
- Order: ${args.orderRef ?? '(no order linked)'}

Recent activity:
${args.activitySummary}

Last few Quo messages with this customer (chronological):
${args.quoHistory || '(none)'}

Output strict JSON, no prose:
{"draft": "<message text>", "skip_reason": null}
OR if you cannot draft a good message:
{"draft": null, "skip_reason": "<short reason>"}`;
}

async function callClaude(apiKey: string, prompt: string): Promise<{ draft: string | null; skip_reason: string | null }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { draft?: string | null; skip_reason?: string | null };
  return {
    draft: parsed.draft ?? null,
    skip_reason: parsed.skip_reason ?? null,
  };
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy via Supabase MCP**

Use `mcp__claude_ai_Supabase__deploy_edge_function` with:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `generate-followup-drafts`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `false` (auth is enforced inside the function, per the security spec pattern)
- `files`: single entry `{ name: 'index.ts', content: <the full file above> }`

Expected: tool returns `status: ACTIVE`.

- [ ] **Step 3: Verify with one known-overdue customer**

Pick a customer who's currently overdue. Find one via:

```sql
select id, full_name, phone, onboard_date, fu1_status
  from customers
 where onboard_date is not null
   and fu1_status is null
   and (onboard_date::date + 7) < current_date
   and phone is not null
 order by onboard_date asc
 limit 3;
```

Invoke the function with that ID via curl (you'll need a valid operator JWT — easiest path: log into the makelila app, copy the `sb-access-token` cookie value):

```bash
curl -s -X POST 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/generate-followup-drafts' \
  -H 'Content-Type: application/json' \
  -H 'apikey: <ANON_KEY>' \
  -H 'Authorization: Bearer <OPERATOR_JWT>' \
  -d '{"customer_ids":["<the-customer-id>"]}'
```

Expected: a JSON response with `drafts: [{...}]` containing one entry. The `draft_message` should:
- Be 1-3 sentences
- Open with the customer's first name
- Reference some specific context (unit serial, days since onboarding, etc.)
- Sound casual

If the draft looks bad, iterate on the prompt in `composePrompt()` and redeploy.

- [ ] **Step 4: Note the security-pass dependency**

When the security pass ships (Phase 3b of `2026-06-03-security-pass.md`), replace lines marked "TEMPORARY inline auth" with:

```ts
import { authenticate } from '../_shared/auth.ts';
// ...
let _caller;
try { _caller = await authenticate(req, admin); }
catch (e) { if (e instanceof Response) return e; throw e; }
if (_caller.kind !== 'user') return j({ error: 'Operator JWT required' }, 403);
```

Leave a `// TODO(security-pass): swap to _shared/auth.ts authenticate()` comment in the meantime so the swap is grep-able.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/generate-followup-drafts/index.ts
git commit -m "feat(followups): generate-followup-drafts edge fn

Auto follow-up queue T1. Drafts a personalized SMS per overdue
customer via claude-haiku-4-5. Auto-skips:
- no phone on file
- active return / refund_approval / cancellation
- outbound Quo message within last 7 days

Pulls context bundle per customer (profile, order, unit, last 20
Quo messages) before calling Claude. Returns drafts as JSON; no
side effects beyond the Anthropic API spend.

Auth: TEMPORARY inline check (verify JWT + profiles.is_internal);
swap to _shared/auth.ts authenticate() when the security pass ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `send-followup-sms` edge function

**Files:**
- Create: `supabase/functions/send-followup-sms/index.ts`

This function sends one SMS via OpenPhone, logs it to `ticket_messages` (creating a `service_tickets` row if no existing Quo thread), updates `customers.fu1_status` / `fu2_status` + `fu_notes`. Idempotent within 5 min on `(customer_id, message)`.

- [ ] **Step 1: Create the file**

Save the following as `supabase/functions/send-followup-sms/index.ts`:

```ts
// Auto follow-up queue Phase 2: send an LLM-drafted SMS via OpenPhone,
// log to ticket_messages, flip the customer's fu1/fu2 status. See
// docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Input = { customer_id: string; message: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const opApiKey    = Deno.env.get('OPENPHONE_API_KEY');
    const opPhoneIds  = (Deno.env.get('OPENPHONE_PHONE_NUMBER_IDS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const testPhone   = Deno.env.get('FOLLOWUP_SMS_TEST_PHONE');
    if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL / SERVICE_ROLE_KEY' }, 500);
    if (!opApiKey || opPhoneIds.length === 0) {
      return j({ error: 'OPENPHONE_API_KEY or OPENPHONE_PHONE_NUMBER_IDS not configured' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // ── TEMPORARY inline auth (see Task 1 Step 4) ───────────────────
    const authz = req.headers.get('authorization') ?? '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    if (!jwt) return j({ error: 'Missing Authorization header' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return j({ error: 'Invalid token' }, 401);
    const { data: callerProfile } = await admin.from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
    if (!callerProfile?.is_internal) return j({ error: 'Not authorized' }, 403);
    const callerUserId = userData.user.id;

    const { customer_id, message } = (await req.json()) as Input;
    if (!customer_id || !message?.trim()) return j({ error: 'customer_id + message required' }, 400);

    // ── Fetch customer ──────────────────────────────────────────────
    const { data: c, error: cErr } = await admin
      .from('customers')
      .select('id, full_name, email, phone, fu1_status, fu2_status, fu_notes')
      .eq('id', customer_id)
      .maybeSingle();
    if (cErr || !c) return j({ error: `Customer not found: ${cErr?.message ?? 'no row'}` }, 404);
    if (!c.phone) return j({ error: 'Customer has no phone on file' }, 400);

    // ── Idempotency: matching body in this customer's Quo thread in the last 5 min? ──
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: recentDup } = await admin
      .from('ticket_messages')
      .select('id, sent_at, service_tickets!inner(customer_id, source)')
      .eq('service_tickets.customer_id', c.id)
      .eq('service_tickets.source', 'quo')
      .eq('direction', 'outbound')
      .eq('body_text', message)
      .gte('sent_at', fiveMinAgo)
      .limit(1);
    if (recentDup && recentDup.length > 0) {
      return j({ ok: true, duplicate: true, ticket_message_id: recentDup[0].id });
    }

    // ── Send via OpenPhone ──────────────────────────────────────────
    const to = testPhone || c.phone;
    const body = testPhone
      ? `[TEST → ${c.phone}] ${message}`
      : message;
    const opRes = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: opApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opPhoneIds[0],
        to: [to],
        content: body,
      }),
    });
    if (!opRes.ok) {
      const txt = await opRes.text();
      return j({ error: `OpenPhone ${opRes.status}: ${txt.slice(0, 300)}` }, 502);
    }
    const opJson = await opRes.json() as { data?: { id?: string } };
    const opMessageId = opJson.data?.id ?? `auto-${crypto.randomUUID()}`;

    // ── Find-or-create the Quo ticket for this customer ─────────────
    const { data: existingTicket } = await admin
      .from('service_tickets')
      .select('id, message_count')
      .eq('customer_id', c.id)
      .eq('source', 'quo')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const now = new Date().toISOString();
    let ticketId: string;
    if (existingTicket) {
      ticketId = existingTicket.id;
      await admin.from('service_tickets').update({
        last_message_at: now,
        message_count: (existingTicket.message_count ?? 0) + 1,
      }).eq('id', existingTicket.id);
    } else {
      const { data: newTicket, error: insErr } = await admin
        .from('service_tickets')
        .insert({
          source: 'quo',
          kind: 'conversation',
          category: 'support',
          status: 'new',
          priority: 'normal',
          subject: `Follow-up SMS to ${c.full_name ?? c.phone}`,
          description: message.slice(0, 200),
          customer_id: c.id,
          customer_name: c.full_name,
          customer_phone: c.phone,
          customer_email: c.email,
          first_message_at: now,
          last_message_at: now,
          message_count: 1,
        })
        .select('id')
        .single();
      if (insErr || !newTicket) return j({ error: `Ticket create failed: ${insErr?.message}` }, 500);
      ticketId = newTicket.id;
    }

    // ── Insert ticket_message ──────────────────────────────────────
    const { error: tmErr } = await admin.from('ticket_messages').insert({
      ticket_id: ticketId,
      gmail_message_id: `quo:auto-fu-${opMessageId}`,
      direction: 'outbound',
      sender: opPhoneIds[0],
      sent_at: now,
      snippet: message.slice(0, 200),
      body_text: message.slice(0, 50_000),
    });
    if (tmErr) return j({ error: `ticket_messages insert: ${tmErr.message}` }, 500);

    // ── Flip fu1 / fu2 + append fu_notes ───────────────────────────
    const tagLine = `[Makelila ${now.slice(0,10)}] Auto FU SMS sent (text: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")`;
    const newFuNotes = c.fu_notes ? `${c.fu_notes}\n${tagLine}` : tagLine;
    const patch: Record<string, string> = { fu_notes: newFuNotes };
    if (!c.fu1_status) patch.fu1_status = 'messaged';
    else if (!c.fu2_status) patch.fu2_status = 'messaged';

    const { error: upErr } = await admin.from('customers').update(patch).eq('id', c.id);
    if (upErr) return j({ error: `customer update: ${upErr.message}` }, 500);

    // ── Activity log ───────────────────────────────────────────────
    await admin.from('activity_log').insert({
      user_id: callerUserId,
      type: 'auto_followup_sent',
      entity: c.id,
      detail: `${c.full_name ?? c.phone}: "${message.slice(0, 100)}"`,
    }).then(() => undefined, () => undefined); // best-effort

    return j({
      ok: true,
      openphone_message_id: opMessageId,
      ticket_id: ticketId,
      test_redirected: !!testPhone,
    });
  } catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy via Supabase MCP**

Same shape as Task 1 Step 2, with `name: 'send-followup-sms'`. Expected: `status: ACTIVE`.

- [ ] **Step 3: Set the test-phone env var BEFORE first invocation**

Use the env-var-from-clipboard pattern. Copy your own phone number (E.164 format, e.g. `+15195551234`) to clipboard, then:

```powershell
$env:PHONE = Get-Clipboard
& "./app/node_modules/.bin/supabase.cmd" secrets set FOLLOWUP_SMS_TEST_PHONE="$env:PHONE" --project-ref txeftbbzeflequvrmjjr
Remove-Item Env:\PHONE
```

Expected: `Finished supabase secrets set.`

- [ ] **Step 4: Verify with one known-overdue customer**

Pick the same test customer as Task 1 Step 3. Invoke:

```bash
curl -s -X POST 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/send-followup-sms' \
  -H 'Content-Type: application/json' \
  -H 'apikey: <ANON_KEY>' \
  -H 'Authorization: Bearer <OPERATOR_JWT>' \
  -d '{"customer_id":"<test-customer-id>","message":"test message from auto followup"}'
```

Expected:
- HTTP 200, response includes `ok: true`, `test_redirected: true`
- An SMS arrives at YOUR phone (the FOLLOWUP_SMS_TEST_PHONE value) prefixed with `[TEST → <customer phone>]`
- The customer's `fu1_status` flips to `'messaged'` (or `fu2_status` if FU1 was already done)
- A new row appears in `ticket_messages` for that customer's Quo thread

Verify via:
```sql
select fu1_status, fu2_status, fu_notes
  from customers where id = '<test-customer-id>';

select tm.body_text, tm.sent_at, tm.direction
  from ticket_messages tm
  join service_tickets st on st.id = tm.ticket_id
 where st.customer_id = '<test-customer-id>'
   and st.source = 'quo'
 order by tm.sent_at desc limit 3;
```

- [ ] **Step 5: Verify idempotency**

Re-run the same curl from Step 4 within 5 minutes. Expected: response `{ ok: true, duplicate: true, ... }` — NO new SMS sent.

- [ ] **Step 6: Note the security-pass dependency**

Same as Task 1 Step 4 — leave a `// TODO(security-pass)` comment so the inline auth check is grep-able for replacement when the security pass lands.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/send-followup-sms/index.ts
git commit -m "feat(followups): send-followup-sms edge fn

Auto follow-up queue T2. Sends an SMS via OpenPhone, logs to
ticket_messages (creating a Quo ticket if no existing thread for
the customer), flips customers.fu1_status (or fu2_status if FU1
already done), appends to fu_notes. Idempotent within 5 minutes
on (customer_id, message).

Respects FOLLOWUP_SMS_TEST_PHONE env var — if set, every send is
redirected to that number with a [TEST → <real>] prefix. Unset to
go live.

Auth: TEMPORARY inline check; swap to _shared/auth.ts when
security pass ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: UI panel + client wrappers + tests

**Files:**
- Edit: `app/src/lib/customers.ts` — add `generateFollowupDrafts()` + `sendFollowupSms()` wrappers + types
- Create: `app/src/modules/Customers/OverdueFollowupPanel.tsx`
- Edit: `app/src/modules/Customers/Customers.module.css` — add panel styles
- Create: `app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx`
- Edit: `app/src/modules/Customers/index.tsx` — mount the panel above filter row

- [ ] **Step 1: Write failing tests**

Create `app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OverdueFollowupPanel } from '../OverdueFollowupPanel';

const { generateMock, sendMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock('../../../lib/customers', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/customers')>('../../../lib/customers');
  return {
    ...actual,
    generateFollowupDrafts: generateMock,
    sendFollowupSms: sendMock,
  };
});

beforeEach(() => {
  generateMock.mockReset();
  sendMock.mockReset();
});

describe('OverdueFollowupPanel', () => {
  it('renders nothing when overdueCount is 0', () => {
    const { container } = render(<OverdueFollowupPanel overdueCount={0} overdueCustomerIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count + Generate button when overdueCount > 0', () => {
    render(<OverdueFollowupPanel overdueCount={42} overdueCustomerIds={[]} />);
    expect(screen.getByText(/42 customers overdue/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate drafts/i })).toBeInTheDocument();
  });

  it('renders drafts after Generate click', async () => {
    generateMock.mockResolvedValue({
      drafts: [
        {
          customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
          days_overdue: 5, fu_kind: 'fu1',
          draft_message: 'hey alice, hope your lila is going well!',
          skip_reason: null, context_summary: 'shipped 5/12, no Quo activity',
        },
        {
          customer_id: 'c2', customer_name: 'Bob', customer_phone: null,
          days_overdue: 10, fu_kind: 'fu1',
          draft_message: null, skip_reason: 'No phone on file', context_summary: 'No phone on file',
        },
      ],
    });
    render(<OverdueFollowupPanel overdueCount={2} overdueCustomerIds={['c1','c2']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate drafts/i }));
    await waitFor(() => expect(screen.getByText(/hey alice/i)).toBeInTheDocument());
    expect(screen.getByText(/No phone on file/i)).toBeInTheDocument();
  });

  it('Approve calls sendFollowupSms and collapses the row', async () => {
    generateMock.mockResolvedValue({
      drafts: [{
        customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
        days_overdue: 5, fu_kind: 'fu1',
        draft_message: 'hey alice!', skip_reason: null, context_summary: '',
      }],
    });
    sendMock.mockResolvedValue({ ok: true });
    render(<OverdueFollowupPanel overdueCount={1} overdueCustomerIds={['c1']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate drafts/i }));
    await waitFor(() => screen.getByText(/hey alice/i));

    fireEvent.click(screen.getByRole('button', { name: /approve & send/i }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith({
      customer_id: 'c1',
      message: 'hey alice!',
    }));
    await waitFor(() => expect(screen.getByText(/✓ sent to alice/i)).toBeInTheDocument());
  });

  it('Skip collapses the row without sending', async () => {
    generateMock.mockResolvedValue({
      drafts: [{
        customer_id: 'c1', customer_name: 'Alice', customer_phone: '+15551111',
        days_overdue: 5, fu_kind: 'fu1',
        draft_message: 'hey alice!', skip_reason: null, context_summary: '',
      }],
    });
    render(<OverdueFollowupPanel overdueCount={1} overdueCustomerIds={['c1']} />);
    fireEvent.click(screen.getByRole('button', { name: /generate drafts/i }));
    await waitFor(() => screen.getByText(/hey alice/i));

    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
    expect(sendMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/— skipped/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx
```

Expected: FAIL with `Failed to resolve import "../OverdueFollowupPanel"`.

- [ ] **Step 3: Add lib wrappers**

In `app/src/lib/customers.ts`, append at the end of the file (after the existing exports):

```ts
// ────────────────────────────────────────────────────────────────────────
// Auto follow-up queue (spec: docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md)
// ────────────────────────────────────────────────────────────────────────

export type FollowupDraft = {
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  days_overdue: number;
  fu_kind: 'fu1' | 'fu2';
  draft_message: string | null;
  skip_reason: string | null;
  context_summary: string;
};

export async function generateFollowupDrafts(customer_ids: string[]): Promise<{ drafts: FollowupDraft[] }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-followup-drafts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ customer_ids }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as { drafts: FollowupDraft[] };
}

export async function sendFollowupSms(input: { customer_id: string; message: string }): Promise<{ ok: boolean; duplicate?: boolean; test_redirected?: boolean }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-followup-sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
```

(The imports `SUPABASE_URL` and `SUPABASE_ANON_KEY` from `./supabase` are already at the top of `customers.ts`, used by `pushToKlaviyo` and `syncCustomersFromHubspot`.)

- [ ] **Step 4: Create the panel component**

Create `app/src/modules/Customers/OverdueFollowupPanel.tsx`:

```tsx
import { useState } from 'react';
import {
  generateFollowupDrafts, sendFollowupSms,
  type FollowupDraft,
} from '../../lib/customers';
import styles from './Customers.module.css';

type Props = {
  overdueCount: number;
  overdueCustomerIds: string[];   // sorted: most-overdue first
};

const BATCH_OPTIONS = [5, 10, 20, 50] as const;
type BatchSize = (typeof BATCH_OPTIONS)[number];

type DraftRowState =
  | { status: 'pending';  draft: FollowupDraft; editedMessage: string }
  | { status: 'sending';  draft: FollowupDraft }
  | { status: 'sent';     draft: FollowupDraft; testRedirected: boolean }
  | { status: 'skipped';  draft: FollowupDraft }
  | { status: 'error';    draft: FollowupDraft; error: string; editedMessage: string };

export function OverdueFollowupPanel({ overdueCount, overdueCustomerIds }: Props) {
  const [batchSize, setBatchSize] = useState<BatchSize>(10);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, DraftRowState>>(new Map());

  if (overdueCount === 0) return null;

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError(null);
    try {
      const ids = overdueCustomerIds.slice(0, batchSize);
      const { drafts } = await generateFollowupDrafts(ids);
      const next = new Map<string, DraftRowState>();
      for (const d of drafts) {
        if (d.skip_reason) {
          next.set(d.customer_id, { status: 'skipped', draft: d });
        } else {
          next.set(d.customer_id, {
            status: 'pending',
            draft: d,
            editedMessage: d.draft_message ?? '',
          });
        }
      }
      setRows(next);
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'Failed to generate drafts');
    } finally {
      setGenerating(false);
    }
  }

  function updateRow(id: string, next: DraftRowState) {
    setRows(prev => {
      const m = new Map(prev);
      m.set(id, next);
      return m;
    });
  }

  async function handleApprove(state: Extract<DraftRowState, { status: 'pending' | 'error' }>) {
    const id = state.draft.customer_id;
    updateRow(id, { status: 'sending', draft: state.draft });
    try {
      const r = await sendFollowupSms({
        customer_id: id,
        message: state.editedMessage,
      });
      updateRow(id, {
        status: 'sent',
        draft: state.draft,
        testRedirected: !!r.test_redirected,
      });
    } catch (e) {
      updateRow(id, {
        status: 'error',
        draft: state.draft,
        error: e instanceof Error ? e.message : 'Send failed',
        editedMessage: state.editedMessage,
      });
    }
  }

  function handleSkip(id: string) {
    const cur = rows.get(id);
    if (!cur || cur.status === 'sent') return;
    updateRow(id, { status: 'skipped', draft: cur.draft });
  }

  return (
    <div className={styles.followupPanel}>
      <div className={styles.followupHeader}>
        <strong>{overdueCount} customers overdue for follow-up</strong>
        <select
          value={batchSize}
          onChange={e => setBatchSize(Number(e.target.value) as BatchSize)}
          disabled={generating}
        >
          {BATCH_OPTIONS.map(n => (
            <option key={n} value={n}>Generate drafts for first {n}</option>
          ))}
        </select>
        <button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Drafting…' : 'Generate'}
        </button>
        <span className={styles.followupHint}>
          Auto-skip: no phone · active return/refund · messaged &lt;7d
        </span>
      </div>
      {generateError && (
        <div className={styles.followupError}>Generate failed: {generateError}</div>
      )}
      {rows.size > 0 && (
        <div className={styles.followupList}>
          {Array.from(rows.values()).map(r => (
            <DraftCard
              key={r.draft.customer_id}
              state={r}
              onApprove={() => {
                if (r.status === 'pending' || r.status === 'error') void handleApprove(r);
              }}
              onSkip={() => handleSkip(r.draft.customer_id)}
              onEdit={text => {
                if (r.status === 'pending' || r.status === 'error') {
                  updateRow(r.draft.customer_id, { ...r, editedMessage: text });
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  state, onApprove, onSkip, onEdit,
}: {
  state: DraftRowState;
  onApprove: () => void;
  onSkip: () => void;
  onEdit: (text: string) => void;
}) {
  const d = state.draft;
  const header = `${d.customer_name} · ${d.fu_kind.toUpperCase()} · ${d.days_overdue}d overdue`;
  if (state.status === 'sent') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSent}>
          ✓ Sent to {d.customer_name}{state.testRedirected ? ' (TEST redirect)' : ''}
        </div>
      </div>
    );
  }
  if (state.status === 'skipped') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSkipped}>
          — Skipped{d.skip_reason ? ` · ${d.skip_reason}` : ''}
        </div>
      </div>
    );
  }
  if (state.status === 'sending') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSending}>Sending…</div>
      </div>
    );
  }
  // pending or error
  const editedMessage = state.editedMessage;
  return (
    <div className={styles.draftCard}>
      <div className={styles.draftHeader}>{header}</div>
      {d.context_summary && (
        <div className={styles.draftContext}>Context: {d.context_summary}</div>
      )}
      <textarea
        className={styles.draftTextarea}
        value={editedMessage}
        onChange={e => onEdit(e.target.value)}
        rows={3}
      />
      {state.status === 'error' && (
        <div className={styles.followupError}>{state.error}</div>
      )}
      <div className={styles.draftActions}>
        <button onClick={onApprove} disabled={!editedMessage.trim()}>
          ✓ Approve &amp; send
        </button>
        <button onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add CSS**

Append to `app/src/modules/Customers/Customers.module.css`:

```css
.followupPanel {
  margin: 0 0 16px 0;
  padding: 12px 14px;
  background: #fffaf0;
  border: 1px solid #fbd38d;
  border-radius: 4px;
}
.followupHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--color-ink, #1a202c);
}
.followupHeader select,
.followupHeader button {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #cbd5e0;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}
.followupHeader button {
  background: var(--color-crimson, #c53030);
  color: #fff;
  border-color: var(--color-crimson, #c53030);
  font-weight: 600;
}
.followupHeader button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.followupHint {
  font-size: 11px;
  color: var(--color-ink-subtle, #718096);
  margin-left: auto;
}
.followupError {
  margin-top: 6px;
  padding: 6px 10px;
  background: #fff5f5;
  color: #9b2c2c;
  border: 1px solid #fc8181;
  border-radius: 4px;
  font-size: 12px;
}
.followupList {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.draftCard {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 4px;
}
.draftHeader {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink, #1a202c);
  margin-bottom: 4px;
}
.draftContext {
  font-size: 11px;
  color: var(--color-ink-subtle, #718096);
  margin-bottom: 6px;
  font-style: italic;
}
.draftTextarea {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid #cbd5e0;
  border-radius: 4px;
  resize: vertical;
}
.draftActions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.draftActions button {
  padding: 5px 12px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid var(--color-border, #cbd5e0);
  background: #fff;
}
.draftActions button:first-child {
  background: var(--color-crimson, #c53030);
  color: #fff;
  border-color: var(--color-crimson, #c53030);
  font-weight: 600;
}
.draftActions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.draftSent {
  font-size: 12px;
  color: #276749;
  font-weight: 600;
}
.draftSkipped {
  font-size: 12px;
  color: var(--color-ink-subtle, #718096);
  font-style: italic;
}
.draftSending {
  font-size: 12px;
  color: var(--color-ink-subtle, #718096);
}
```

- [ ] **Step 6: Mount the panel in Customers/index.tsx**

In `app/src/modules/Customers/index.tsx`, find the existing filter-row section (search for `<div className={styles.filterRow}>`). Add an import at the top:

```tsx
import { OverdueFollowupPanel } from './OverdueFollowupPanel';
```

In the existing top-level computation (where `withFu` is computed), derive the overdue list:

```tsx
const overdueIds = useMemo(() => {
  return withFu
    .filter(({ fu }) => fu === 'overdue_fu1' || fu === 'overdue_fu2')
    .sort((a, b) => {
      // Most overdue first: lower onboard_date = more days overdue
      const ao = a.c.onboard_date ?? '9999-12-31';
      const bo = b.c.onboard_date ?? '9999-12-31';
      return ao.localeCompare(bo);
    })
    .map(({ c }) => c.id);
}, [withFu]);
```

In the JSX, just BEFORE the existing filter-row `<div>`, insert:

```tsx
<OverdueFollowupPanel
  overdueCount={overdueIds.length}
  overdueCustomerIds={overdueIds}
/>
```

- [ ] **Step 7: Run tests + tsc**

```bash
cd app && npx vitest run src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx
```

Expected: 5/5 pass.

```bash
cd app && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -E "(Customers|customers\.ts)" | head -10
```

Expected: no errors.

```bash
cd app && npx vitest run
```

Expected: full suite still passes (the prior 102 + 5 new = 107 tests).

- [ ] **Step 8: Smoke test in browser**

```bash
cd app && npm run dev
```

Open http://localhost:5173 → Customers tab. Expect:
- Orange panel at the top: "42 customers overdue for follow-up"
- Click Generate → spinner → draft cards appear
- One card per customer, with the LLM-drafted message in an editable textarea
- Skipped customers show a greyed "— Skipped · reason" line
- Click Approve & send on one → spinner → green "✓ Sent" message (your test phone receives the SMS prefixed with `[TEST → <customer phone>]`)
- Click Skip on another → row collapses with grey "— Skipped"

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/customers.ts \
        app/src/modules/Customers/OverdueFollowupPanel.tsx \
        app/src/modules/Customers/Customers.module.css \
        app/src/modules/Customers/__tests__/OverdueFollowupPanel.test.tsx \
        app/src/modules/Customers/index.tsx
git commit -m "feat(followups): OverdueFollowupPanel + client wrappers

Auto follow-up queue T3. Adds the operator-facing UI:
- generateFollowupDrafts() / sendFollowupSms() client wrappers in
  lib/customers.ts
- OverdueFollowupPanel component renders a Generate button + per-
  customer draft cards (editable textarea + Approve/Skip)
- Mounted at the top of the Customers tab when overdue > 0
- 5 vitest tests cover empty state, generate, approve flow, skip flow

End-to-end: Reina clicks Generate → up to 50 LLM drafts arrive in
~10s → reviews each → Approve fires send-followup-sms which delivers
via OpenPhone, flips fu1/fu2 status, logs to ticket_messages.
FOLLOWUP_SMS_TEST_PHONE redirect is in effect until manually unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Go-live checklist (no commit)

After Reina has used the panel a few times in test mode and is happy with the drafts:

- [ ] **Step 1: Unset the test-phone redirect**

```powershell
& "./app/node_modules/.bin/supabase.cmd" secrets unset FOLLOWUP_SMS_TEST_PHONE --project-ref txeftbbzeflequvrmjjr
```

Expected: `Finished supabase secrets unset.` Subsequent sends go to real customer phones.

- [ ] **Step 2: First production batch — supervised**

Reina runs the panel with batch size 5. Watch the OpenPhone send log + customer responses for the next hour. If anything weird (off-tone messages, wrong number, etc.), unset the FU2/FU1 status manually and pause the panel.

- [ ] **Step 3: Verify the overdue count dropped**

```sql
select count(*) filter (
  where onboard_date is not null and fu1_status is null
    and (onboard_date::date + 7) < current_date
) as overdue_fu1,
count(*) filter (
  where onboard_date is not null and fu1_status is not null and fu2_status is null
    and (onboard_date::date + 30) < current_date
) as overdue_fu2
from customers;
```

Expected: lower than the pre-batch numbers. If Reina sent 5 follow-ups, expect overdue_fu1 + overdue_fu2 to drop by ~5 (might be less if any were FU1→FU2 transitions).

- [ ] **Step 4: When the security pass ships, swap the inline auth**

Replace the temporary inline `// TODO(security-pass)` blocks in both edge functions with the `authenticate()` wrapper from `_shared/auth.ts`. Redeploy via MCP. Run the panel once to confirm it still works.
