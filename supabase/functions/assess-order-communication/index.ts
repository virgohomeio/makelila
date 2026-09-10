// Reads a customer's recent support history (Quo SMS + the two support
// mailboxes) and writes one verdict per order: is anything here a reason not to
// put this unit on a truck today?
//
// The Sales tab renders the verdict in the order's Customer card. The work is
// here rather than in the browser because the app talks only to Supabase — the
// message bodies reach the database through sync-quo-tickets and
// sync-gmail-tickets, and this function reads what those left behind.
//
// KNOWN GAP (2026-09-09): sync-gmail-tickets returns
// {"skipped":true,"reason":"GOOGLE_SERVICE_ACCOUNT_KEY or GMAIL_DELEGATED_MAILBOXES
// not configured"} on every run, so no support email has ever reached the
// database. That is a Workspace admin task, not a code one. Until it is done
// this function honestly reports email as not connected (channels_scanned) and
// the card says so, rather than passing off an SMS-only reading as a full
// all-channels clearance. Setting the two secrets is the only step needed to
// light the email leg up — no change here.
//
// Auth: cron (X-Cron-Secret) for the scheduled sweep, or an internal operator
// JWT for the card's "Re-check" button.
//
// Body:
//   {"order_id": "<uuid>"}                 — one order, forced re-read
//   {"scope": "pending", "limit": 40}      — the cron sweep
//
// Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { chatCompletion } from '../_shared/openaiCompat.ts';
import { qwenConfigFromEnv } from '../_shared/qwen.ts';
import { openaiConfigFromEnv } from '../_shared/openai.ts';
import {
  PROVIDER_LABELS, chainFailures, jsonFromModelText, pickProviders,
  type LlmProvider,
} from '../_shared/llmProviders.ts';
import {
  ASSESSMENT_SYSTEM_PROMPT,
  buildTranscript,
  emailKey,
  fingerprintSource,
  noContactAssessment,
  parseAssessment,
  phoneKey,
  selectMessages,
  sha256Hex,
  type AssessmentCore,
  type ChannelsScanned,
  type ChannelStatus,
  type CommMessage,
} from '../_shared/commAssessment.ts';

/** How far back a customer's history stays relevant to a shipping decision.
 *  Four months covers a pre-order placed well before its batch landed. */
const WINDOW_DAYS = 120;
/** Newest N messages fed to the model. Long troubleshooting threads run to
 *  hundreds; the tail is what bears on shipping. */
const MAX_MESSAGES = 60;
/** Model calls per cron run. Unchanged conversations short-circuit on the
 *  fingerprint and don't count, so this only bounds genuinely new activity. */
const LLM_BUDGET_PER_RUN = 25;
/** Statuses that still have a shipping decision ahead of them. */
const PENDING_STATUSES = ['pending', 'flagged', 'held'];

type OrderRow = {
  id: string;
  order_ref: string;
  status: string;
  kind: string;
  placed_at: string | null;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  address_line: string | null;
  city: string | null;
  region_state: string | null;
  country: string | null;
};

type TicketRow = {
  id: string;
  source: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
};

type MessageRow = {
  id: string;
  ticket_id: string;
  direction: string | null;
  sent_at: string | null;
  body_text: string | null;
  snippet: string | null;
};

type OrderOutcome = {
  order_ref: string;
  verdict: string | null;
  reason: 'assessed' | 'unchanged' | 'no_messages' | 'budget' | 'error';
  provider?: string;
  error?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const body = await req.json().catch(() => ({})) as { order_id?: string; scope?: string; limit?: number };

  const providers = pickProviders(
    {
      claude: Deno.env.get('ANTHROPIC_API_KEY'),
      qwen:   Deno.env.get('QWEN_API_KEY'),
      openai: Deno.env.get('OPENAI_API_KEY'),
    },
    Deno.env.get('LLM_PROVIDER_ORDER'),
  );

  const orders = await loadOrders(admin, body);
  if (orders.length === 0) return json({ assessed: 0, results: [], reason: 'no matching orders' }, 200);

  const channels = await loadChannelStatus(admin);
  const tickets = await loadTicketIndex(admin);

  const budget = { left: body.order_id ? 1 : LLM_BUDGET_PER_RUN };
  const results: OrderOutcome[] = [];
  for (const order of orders) {
    results.push(await assessOne(admin, order, tickets, channels, providers, budget, { force: !!body.order_id }));
  }

  return json({
    assessed: results.filter(r => r.reason === 'assessed').length,
    providers_available: providers.map(p => PROVIDER_LABELS[p]),
    channels,
    results,
  }, 200);
}

// ============================================================ Loading

async function loadOrders(
  admin: SupabaseClient,
  body: { order_id?: string; scope?: string; limit?: number },
): Promise<OrderRow[]> {
  const cols = 'id, order_ref, status, kind, placed_at, created_at, customer_id, customer_name, customer_email, customer_phone, address_line, city, region_state, country';

  if (body.order_id) {
    const { data, error } = await admin.from('orders').select(cols).eq('id', body.order_id).maybeSingle();
    if (error) throw new Error(`orders lookup: ${error.message}`);
    return data ? [data as OrderRow] : [];
  }

  // The sweep runs oldest-assessment-first so a large backlog drains evenly
  // instead of the same head of the queue being re-read every 15 minutes.
  const { data, error } = await admin
    .from('orders')
    .select(cols)
    .in('status', PENDING_STATUSES)
    .order('placed_at', { ascending: false, nullsFirst: false })
    .limit(Math.min(body.limit ?? 200, 400));
  if (error) throw new Error(`orders sweep: ${error.message}`);
  return (data ?? []) as OrderRow[];
}

/** Whether each channel has ever delivered anything, and how fresh it is.
 *
 *  Recorded on every assessment so the card can never present a partial
 *  reading as a complete one. `connected: false` means "we did not read this
 *  channel at all", which is a different claim from "this channel was quiet". */
async function loadChannelStatus(admin: SupabaseClient): Promise<ChannelsScanned> {
  const forSource = async (sources: string[]): Promise<ChannelStatus> => {
    const { data, error } = await admin
      .from('service_tickets')
      .select('last_message_at')
      .in('source', sources)
      .not('last_message_at', 'is', null)
      .order('last_message_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`channel status (${sources.join('/')}): ${error.message}`);
    const newest = (data ?? [])[0]?.last_message_at ?? null;
    return { connected: !!newest, last_synced_at: newest, message_count: 0 };
  };

  return { quo: await forSource(['quo']), email: await forSource(['gmail']) };
}

/** Every support ticket, indexed by each of the three things that identify a
 *  person. One fetch per invocation, reused for every order in the sweep — the
 *  table holds a few hundred rows, and scanning it once per order instead
 *  meant re-reading the same data 150 times a run. */
type TicketIndex = {
  byCustomerId: Map<string, TicketRow[]>;
  byEmail: Map<string, TicketRow[]>;
  byPhone: Map<string, TicketRow[]>;
  byId: Map<string, TicketRow>;
};

async function loadTicketIndex(admin: SupabaseClient): Promise<TicketIndex> {
  const { data, error } = await admin
    .from('service_tickets')
    .select('id, source, customer_id, customer_email, customer_phone')
    .limit(10000);
  if (error) throw new Error(`service_tickets: ${error.message}`);

  const index: TicketIndex = {
    byCustomerId: new Map(), byEmail: new Map(), byPhone: new Map(), byId: new Map(),
  };
  const push = (map: Map<string, TicketRow[]>, key: string | null, t: TicketRow) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(t); else map.set(key, [t]);
  };

  for (const t of (data ?? []) as TicketRow[]) {
    index.byId.set(t.id, t);
    push(index.byCustomerId, t.customer_id, t);
    push(index.byEmail, emailKey(t.customer_email), t);
    // Phone is keyed on last-ten-digits rather than compared in SQL: the column
    // holds every format from "+14165550134" to "(416) 555-0134", and only that
    // reduction joins them. A LIKE would miss the punctuated forms, which are
    // most of them.
    push(index.byPhone, phoneKey(t.customer_phone), t);
  }
  return index;
}

/** This order's customer's tickets, found by customer_id, email or phone —
 *  whichever the ticket happens to carry. Shopify and Quo populate different
 *  subsets of the three, so matching on only one loses much of the history. */
function ticketsForOrder(index: TicketIndex, order: OrderRow): TicketRow[] {
  const found = new Map<string, TicketRow>();
  const add = (list: TicketRow[] | undefined) => {
    for (const t of list ?? []) found.set(t.id, t);
  };
  if (order.customer_id) add(index.byCustomerId.get(order.customer_id));
  const email = emailKey(order.customer_email);
  if (email) add(index.byEmail.get(email));
  const phone = phoneKey(order.customer_phone);
  if (phone) add(index.byPhone.get(phone));
  return [...found.values()];
}

async function loadMessages(
  admin: SupabaseClient,
  order: OrderRow,
  index: TicketIndex,
): Promise<CommMessage[]> {
  const tickets = ticketsForOrder(index, order);
  if (tickets.length === 0) return [];
  const byId = new Map(tickets.map(t => [t.id, t]));

  const { data: msgs, error } = await admin
    .from('ticket_messages')
    .select('id, ticket_id, direction, sent_at, body_text, snippet')
    .in('ticket_id', [...byId.keys()])
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(`ticket_messages: ${error.message}`);

  return ((msgs ?? []) as MessageRow[]).map(m => ({
    id: m.id,
    ticket_id: m.ticket_id,
    channel: byId.get(m.ticket_id)?.source === 'quo' ? 'quo' as const : 'email' as const,
    direction: m.direction === 'outbound' ? 'outbound' as const : 'inbound' as const,
    sent_at: m.sent_at!,
    text: (m.body_text ?? m.snippet ?? '').trim(),
  }));
}

// ============================================================ Per-order assessment

async function assessOne(
  admin: SupabaseClient,
  order: OrderRow,
  index: TicketIndex,
  channels: ChannelsScanned,
  providers: LlmProvider[],
  budget: { left: number },
  opts: { force: boolean },
): Promise<OrderOutcome> {
  try {
    const all = await loadMessages(admin, order, index);
    const msgs = selectMessages(all, { now: new Date(), windowDays: WINDOW_DAYS, max: MAX_MESSAGES });

    const scanned: ChannelsScanned = {
      quo:   { ...channels.quo,   message_count: msgs.filter(m => m.channel === 'quo').length },
      email: { ...channels.email, message_count: msgs.filter(m => m.channel === 'email').length },
    };

    const fingerprint = await sha256Hex(fingerprintSource(msgs, order.status));

    if (!opts.force) {
      const { data: existing } = await admin
        .from('order_comm_assessments')
        .select('input_fingerprint, verdict')
        .eq('order_id', order.id)
        .maybeSingle();
      // Nothing new has been said and the order has not moved, so the standing
      // verdict is still the answer — no model call, no write.
      if (existing?.input_fingerprint === fingerprint) {
        return { order_ref: order.order_ref, verdict: existing.verdict, reason: 'unchanged' };
      }
    }

    // Silence is a clearance, but a differently-worded one, and it costs
    // nothing to reach.
    if (msgs.length === 0) {
      await writeAssessment(admin, order, noContactAssessment(), scanned, msgs, fingerprint, null, null);
      return { order_ref: order.order_ref, verdict: 'no_contact', reason: 'no_messages' };
    }

    if (budget.left <= 0) return { order_ref: order.order_ref, verdict: null, reason: 'budget' };
    budget.left--;

    const { core, provider } = await runModel(order, msgs, providers);
    await writeAssessment(admin, order, core, scanned, msgs, fingerprint, provider, null);
    return { order_ref: order.order_ref, verdict: core.verdict, reason: 'assessed', provider };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // The failure is recorded against the order without disturbing whatever
    // verdict is already there: a provider outage should degrade the card to a
    // stale answer, never blank it or silently flip it to "clear".
    await admin.from('order_comm_assessments')
      .update({ error: message.slice(0, 500), assessed_at: new Date().toISOString() })
      .eq('order_id', order.id);
    return { order_ref: order.order_ref, verdict: null, reason: 'error', error: message };
  }
}

async function writeAssessment(
  admin: SupabaseClient,
  order: OrderRow,
  core: AssessmentCore,
  channels: ChannelsScanned,
  msgs: CommMessage[],
  fingerprint: string,
  provider: LlmProvider | null,
  error: string | null,
): Promise<void> {
  const { error: upsertErr } = await admin
    .from('order_comm_assessments')
    .upsert({
      order_id: order.id,
      verdict: core.verdict,
      headline: core.headline,
      concerns: core.concerns,
      evidence: core.evidence,
      channels_scanned: channels,
      message_count: msgs.length,
      last_message_at: msgs.length ? msgs[msgs.length - 1].sent_at : null,
      input_fingerprint: fingerprint,
      model: provider ? PROVIDER_LABELS[provider] : null,
      assessed_at: new Date().toISOString(),
      error,
    }, { onConflict: 'order_id' });
  if (upsertErr) throw new Error(`upsert assessment: ${upsertErr.message}`);
}

// ============================================================ The model

function orderContext(order: OrderRow): string {
  const placed = (order.placed_at ?? order.created_at ?? '').slice(0, 10);
  const where = [order.city, order.region_state, order.country].filter(Boolean).join(', ');
  return [
    `Order ${order.order_ref} (${order.kind}), placed ${placed}, currently "${order.status}".`,
    `Customer: ${order.customer_name ?? 'unknown'}.`,
    `Shipping to: ${[order.address_line, where].filter(Boolean).join(', ') || 'unknown'}.`,
  ].join('\n');
}

async function runModel(
  order: OrderRow,
  msgs: CommMessage[],
  providers: LlmProvider[],
): Promise<{ core: AssessmentCore; provider: LlmProvider }> {
  if (providers.length === 0) {
    throw new Error('No LLM provider configured (set ANTHROPIC_API_KEY, QWEN_API_KEY or OPENAI_API_KEY)');
  }

  const user = [
    orderContext(order),
    '',
    'Support history, oldest first:',
    '<<<',
    buildTranscript(msgs),
    '>>>',
  ].join('\n');

  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const reply = provider === 'claude'
        ? await claudeAssess(Deno.env.get('ANTHROPIC_API_KEY')!, user)
        : await compatAssess(provider, user);
      return { core: parseAssessment(jsonFromModelText(reply)), provider };
    } catch (e) {
      failures.push((e as Error)?.message ?? String(e));
    }
  }
  throw new Error(chainFailures(failures));
}

async function claudeAssess(apiKey: string, user: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: ASSESSMENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      }),
    });
  } catch (e) {
    throw new Error(`Claude chat failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');
  if (!text) throw new Error('Claude returned no text');
  return text;
}

async function compatAssess(provider: Exclude<LlmProvider, 'claude'>, user: string): Promise<string> {
  const cfg = provider === 'qwen' ? qwenConfigFromEnv() : openaiConfigFromEnv();
  if (!cfg) throw new Error(`${PROVIDER_LABELS[provider]} not configured`);
  const prefix = provider.toUpperCase();
  return chatCompletion({
    label: PROVIDER_LABELS[provider],
    apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
    keyEnvVar: `${prefix}_API_KEY`, baseUrlEnvVar: `${prefix}_BASE_URL`, modelEnvVar: `${prefix}_MODEL`,
    maxTokens: 700,
    system: ASSESSMENT_SYSTEM_PROMPT,
    user,
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
