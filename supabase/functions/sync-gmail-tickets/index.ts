// Sync Gmail threads from delegated mailboxes into service_tickets +
// ticket_messages. PR1 of the Gmail ticket pipeline — schema + sync only.
// Classifier runs in PR2 (this function leaves new tickets with no priority/
// category fields populated beyond defaults; the existing 'new'/'normal'
// defaults are fine).
//
// Auth: Google Workspace service account with domain-wide delegation.
//   - GOOGLE_SERVICE_ACCOUNT_KEY: base64-encoded service account JSON
//   - GMAIL_DELEGATED_MAILBOXES:  comma-separated list of mailboxes to read
//
// First run per mailbox: lists inbox threads with the brief's query
// (newer_than:30d, excluding promo/social/etc) and captures profile.historyId.
// Subsequent runs: history.list from last_history_id; only re-fetch threads
// that changed.
//
// Setup runbook: docs/gmail-sync-setup.md

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';
import { corsHeaders } from '../_shared/cors.ts';
import { classify, type Category, type Priority, type ThreadInput } from '../_shared/classifier.ts';
import { llmClassify, sha256Hex } from '../_shared/classifier-llm.ts';
import { parseQuoSubject, parseFromHeader, normalizePhone } from '../_shared/quo-parsers.ts';

// Maps classifier priority ('urgent'|'high'|'medium'|'low') to the DB enum
// on service_tickets.priority ('urgent'|'high'|'normal'|'low').
const PRIORITY_TO_DB: Record<Priority, 'urgent' | 'high' | 'normal' | 'low'> = {
  urgent: 'urgent',
  high:   'high',
  medium: 'normal',
  low:    'low',
};

const LLM_BUDGET_PER_RUN = 20;

type RunBudget = { llmCalls: number; llmMax: number };

const GMAIL_QUERY = 'in:inbox -from:me -category:promotions -category:social -category:updates -category:forums newer_than:30d';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify';
const SYNC_LABEL_NAME = 'makelila/synced';
const VIRGO_DOMAIN = '@virgohome.io';

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: {
    headers?: { name: string; value: string }[];
    parts?: GmailPart[];
    body?: { data?: string };
    mimeType?: string;
  };
};
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailThread = { id: string; historyId?: string; messages?: GmailMessage[] };

type RunResult = {
  mailbox: string;
  ok: boolean;
  bootstrap: boolean;
  threads_processed: number;
  messages_upserted: number;
  tickets_upserted: number;
  history_id_after: string | null;
  error?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(); }
  catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return jsonResponse({ error: `Uncaught: ${msg}` }, 500);
  }
});

async function handle(): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const saKeyB64 = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  const mailboxes = (Deno.env.get('GMAIL_DELEGATED_MAILBOXES') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  if (!saKeyB64 || mailboxes.length === 0) {
    // Soft no-op when not yet configured — cron will hit this until Workspace
    // admin completes setup. Don't fail the run.
    return jsonResponse({
      skipped: true,
      reason: 'GOOGLE_SERVICE_ACCOUNT_KEY or GMAIL_DELEGATED_MAILBOXES not configured',
    }, 200);
  }

  let saKey: ServiceAccountKey;
  try {
    saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
  } catch (e) {
    return jsonResponse({ error: `GOOGLE_SERVICE_ACCOUNT_KEY decode/parse failed: ${(e as Error).message}` }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const budget: RunBudget = { llmCalls: 0, llmMax: LLM_BUDGET_PER_RUN };
  const results: RunResult[] = [];
  for (const mailbox of mailboxes) {
    const r = await syncMailbox(admin, saKey, mailbox, budget);
    results.push(r);
  }

  const ok = results.every(r => r.ok);
  return jsonResponse({ ok, results }, ok ? 200 : 207);
}

// ============================================================ Per-mailbox sync
async function syncMailbox(
  admin: SupabaseClient, saKey: ServiceAccountKey, mailbox: string, budget: RunBudget,
): Promise<RunResult> {
  const result: RunResult = {
    mailbox,
    ok: false,
    bootstrap: false,
    threads_processed: 0,
    messages_upserted: 0,
    tickets_upserted: 0,
    history_id_after: null,
  };

  try {
    const token = await getAccessToken(saKey, mailbox);
    const { data: stateRow } = await admin
      .from('gmail_sync_state')
      .select('*')
      .eq('mailbox', mailbox)
      .maybeSingle();
    const lastHistoryId: string | null = (stateRow?.last_history_id ?? null);
    let threadIds: string[];
    let historyIdAfter: string;

    if (!lastHistoryId) {
      // Bootstrap: list threads via query, then take profile.historyId as the
      // starting point for next run.
      result.bootstrap = true;
      threadIds = await listAllThreadIds(mailbox, token, GMAIL_QUERY);
      const profile = await gmailGet<{ historyId: string }>(mailbox, token, `/profile`);
      historyIdAfter = profile.historyId;
    } else {
      // Incremental: only fetch threads with messageAdded events.
      const hist = await listHistory(mailbox, token, lastHistoryId);
      threadIds = hist.threadIds;
      historyIdAfter = hist.historyIdAfter ?? lastHistoryId;
    }

    // Ensure makelila/synced label exists (best-effort).
    const labelId = await ensureLabel(mailbox, token, SYNC_LABEL_NAME).catch(() => null);

    for (const threadId of threadIds) {
      const thread = await gmailGet<GmailThread>(
        mailbox, token, `/threads/${threadId}?format=full`,
      ).catch((e) => {
        // Thread may have been deleted between history.list and fetch. Skip.
        console.warn(`[${mailbox}] thread ${threadId} fetch failed: ${(e as Error).message}`);
        return null;
      });
      if (!thread || !thread.messages || thread.messages.length === 0) continue;

      const upserted = await upsertThread(admin, mailbox, thread, budget);
      if (upserted) {
        result.threads_processed++;
        result.messages_upserted += upserted.messageCount;
        result.tickets_upserted += 1;
        if (labelId) {
          await applyLabel(mailbox, token, threadId, labelId).catch(() => { /* best-effort */ });
        }
      }
    }

    result.history_id_after = historyIdAfter;
    result.ok = true;

    // Persist state.
    await admin.from('gmail_sync_state').upsert({
      mailbox,
      last_history_id: historyIdAfter,
      last_run_at: new Date().toISOString(),
      last_run_status: 'ok',
      last_run_message: result.bootstrap
        ? `bootstrap: ${result.threads_processed} threads`
        : `incremental: ${result.threads_processed} threads`,
      threads_seen_total: (stateRow?.threads_seen_total ?? 0) + result.threads_processed,
      messages_seen_total: (stateRow?.messages_seen_total ?? 0) + result.messages_upserted,
    });
  } catch (err) {
    result.error = (err as Error).message;
    await admin.from('gmail_sync_state').upsert({
      mailbox,
      last_run_at: new Date().toISOString(),
      last_run_status: 'error',
      last_run_message: result.error.slice(0, 500),
    });
  }
  return result;
}

// ============================================================ Upsert one thread
async function upsertThread(
  admin: SupabaseClient, mailbox: string, thread: GmailThread, budget: RunBudget,
): Promise<{ messageCount: number } | null> {
  const messages = (thread.messages ?? []).slice().sort((a, b) => {
    return Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0);
  });
  if (messages.length === 0) return null;

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  const subjectHeader = header(firstMsg, 'Subject') ?? '(no subject)';
  const fromHeader = header(firstMsg, 'From') ?? '';

  // Quo subject parse first; falls back to direct-email From parse.
  const quo = parseQuoSubject(subjectHeader);
  const fromParsed = parseFromHeader(fromHeader);
  const customer_name = quo.name ?? fromParsed.name ?? null;
  const customer_phone = quo.phone ? normalizePhone(quo.phone) : null;
  const customer_email = fromParsed.email ?? null;

  const firstAt = msgDate(firstMsg);
  const lastAt = msgDate(lastMsg);

  const ticketRow = {
    category: 'support',                            // PR1 default; classifier (PR2) may refine
    source: 'gmail' as const,
    subject: subjectHeader.slice(0, 500),
    gmail_thread_id: thread.id,
    gmail_account: mailbox,
    customer_name,
    customer_email,
    customer_phone,
    message_count: messages.length,
    first_message_at: firstAt,
    last_message_at: lastAt,
  };

  const { data: ticket, error: upErr } = await admin
    .from('service_tickets')
    .upsert(ticketRow, { onConflict: 'gmail_thread_id' })
    .select('id, status, priority, is_manually_overridden, last_classified_at, customer_name')
    .single();
  if (upErr || !ticket) {
    throw new Error(`upsert ticket failed (thread ${thread.id}): ${upErr?.message ?? 'no row'}`);
  }

  // Upsert messages.
  const rows = messages.map(m => {
    const senderHeader = header(m, 'From') ?? '';
    const sender = parseFromHeader(senderHeader);
    const direction: 'inbound' | 'outbound' =
      sender.email && (sender.email.endsWith(VIRGO_DOMAIN) || sender.email === mailbox)
        ? 'outbound' : 'inbound';
    return {
      ticket_id: ticket.id,
      gmail_message_id: m.id,
      direction,
      sender: senderHeader || null,
      sent_at: msgDate(m),
      snippet: (m.snippet ?? '').slice(0, 2000),
      body_text: extractBodyText(m).slice(0, 50_000) || null,
    };
  });
  // Upsert in batches to avoid huge payloads. Service rows are small; 100 at a time is plenty.
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { error } = await admin
      .from('ticket_messages')
      .upsert(slice, { onConflict: 'gmail_message_id' });
    if (error) throw new Error(`upsert messages failed: ${error.message}`);
  }

  // If the most recent message is staff-side, flip an "open" status to
  // waiting_on_customer once we've replied. Open = waiting_on_us | in_progress.
  // Don't touch on_hold/closed/already-waiting.
  const lastDirection = rows[rows.length - 1]?.direction;
  const OPEN_STATUSES = new Set(['waiting_on_us', 'in_progress']);
  if (lastDirection === 'outbound' && OPEN_STATUSES.has(ticket.status)) {
    await admin.from('service_tickets')
      .update({ status: 'waiting_on_customer' })
      .eq('id', ticket.id);
  }

  // Classify if needed: new ticket, or new messages since last classification.
  const lastSentMs = Date.parse(lastAt ?? '') || 0;
  const lastClassifiedMs = Date.parse(ticket.last_classified_at ?? '') || 0;
  const needsClassify = !ticket.last_classified_at || lastSentMs > lastClassifiedMs;
  if (needsClassify) {
    await classifyAndApply(admin, ticket, subjectHeader, messages, rows, mailbox, budget);
  }

  return { messageCount: rows.length };
}

// ============================================================ Classifier + LLM integration
async function classifyAndApply(
  admin: SupabaseClient,
  ticket: { id: string; status: string; priority: string; is_manually_overridden: boolean | null; customer_name: string | null },
  subject: string,
  gmailMessages: GmailMessage[],
  rows: Array<{ direction: 'inbound' | 'outbound'; sent_at: string | null; body_text: string | null; snippet: string | null }>,
  mailbox: string,
  budget: RunBudget,
): Promise<void> {
  const threadInput: ThreadInput = {
    subject,
    customer_name: ticket.customer_name,
    messages: rows.map(r => ({
      direction: r.direction,
      sent_at: r.sent_at ?? new Date().toISOString(),
      body_text: r.body_text ?? r.snippet ?? '',
      snippet: r.snippet ?? undefined,
    })),
  };
  const rulesResult = classify(threadInput);

  // Start with rules result. Promote to LLM if rules fell through to 'other'
  // and we have budget left.
  let finalPriority: Priority = rulesResult.priority;
  let finalCategory: Category = rulesResult.category;
  let finalSummary = rulesResult.summary;
  let finalNextAction = rulesResult.suggested_next_action;
  let finalStatus = rulesResult.status;
  let method: 'rules' | 'llm' = 'rules';
  let ruleId: string | null = rulesResult.ruleId ?? null;
  let llmInputHash: string | null = null;
  let llmConfidence: number | null = null;

  if (rulesResult.category === 'other' && budget.llmCalls < budget.llmMax) {
    const lastMsgId = gmailMessages[gmailMessages.length - 1]?.id ?? '';
    llmInputHash = await sha256Hex(`${ticket.id}|${lastMsgId}`);
    const llmOut = await llmClassify(threadInput);
    if (llmOut) {
      finalPriority = llmOut.priority;
      finalCategory = llmOut.category;
      finalSummary = llmOut.summary;
      finalNextAction = llmOut.suggested_next_action;
      finalStatus = undefined; // LLM never auto-resolves; only closed-ack rule does
      llmConfidence = llmOut.confidence;
      method = 'llm';
      ruleId = null;
      budget.llmCalls += 1;
    }
  }

  const update: Record<string, unknown> = {
    last_classified_at: new Date().toISOString(),
  };
  // Only write classifier fields if staff hasn't manually overridden.
  if (!ticket.is_manually_overridden) {
    update.priority = PRIORITY_TO_DB[finalPriority];
    update.topic = finalCategory;
    update.summary = finalSummary;
    update.suggested_next_action = finalNextAction;
    if (llmConfidence != null) update.classification_confidence = llmConfidence;
    if (finalStatus === 'closed' && ['waiting_on_us','in_progress','waiting_on_customer'].includes(ticket.status)) {
      update.status = 'closed';
      update.closed_at = new Date().toISOString();
    }
  }

  const { error: updErr } = await admin.from('service_tickets').update(update).eq('id', ticket.id);
  if (updErr) {
    console.warn(`classify update failed (ticket ${ticket.id}): ${updErr.message}`);
    return;
  }

  await admin.from('ticket_classification_log').insert({
    ticket_id: ticket.id,
    method,
    priority: finalPriority,
    category: finalCategory,
    rule_id: ruleId,
    llm_input_hash: llmInputHash,
    confidence: llmConfidence,
  });

  // Slack notify: classifier-driven escalation to urgent (not manual edits).
  const prevDbPriority = ticket.priority;
  const newDbPriority = PRIORITY_TO_DB[finalPriority];
  if (!ticket.is_manually_overridden && newDbPriority === 'urgent' && prevDbPriority !== 'urgent') {
    await notifySlackUrgent({
      ticket_id: ticket.id,
      subject,
      customer_name: ticket.customer_name,
      summary: finalSummary,
      mailbox,
    }).catch(e => console.warn(`slack notify failed: ${(e as Error).message}`));
  }
}

// ============================================================ Slack notify (best-effort)
async function notifySlackUrgent(args: {
  ticket_id: string;
  subject: string;
  customer_name: string | null;
  summary: string;
  mailbox: string;
}): Promise<void> {
  const webhook = Deno.env.get('SLACK_TICKET_WEBHOOK_URL');
  if (!webhook) return;                                     // feature off
  const text = `:rotating_light: *Urgent ticket* — ${args.customer_name ?? 'Unknown customer'} via ${args.mailbox}\n*${args.subject}*\n${args.summary}`;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// ============================================================ Header / parse helpers
function header(msg: GmailMessage, name: string): string | null {
  const h = msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}
function msgDate(msg: GmailMessage): string | null {
  if (!msg.internalDate) return null;
  const ms = Number(msg.internalDate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Walk MIME parts, prefer text/plain, fall back to text/html stripped.
function extractBodyText(msg: GmailMessage): string {
  const collected: { mime: string; data: string }[] = [];
  function walk(part: GmailPart | undefined) {
    if (!part) return;
    if (part.body?.data) {
      collected.push({ mime: part.mimeType ?? 'text/plain', data: part.body.data });
    }
    for (const p of part.parts ?? []) walk(p);
  }
  walk(msg.payload);
  const plain = collected.find(p => p.mime === 'text/plain');
  const html = collected.find(p => p.mime === 'text/html');
  const pick = plain ?? html ?? collected[0];
  if (!pick) return '';
  try {
    const decoded = decodeBase64Url(pick.data);
    return pick.mime === 'text/html' ? stripHtml(decoded) : decoded;
  } catch { return ''; }
}
function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return new TextDecoder().decode(Uint8Array.from(atob(padded + '='.repeat(padLen)), c => c.charCodeAt(0)));
}
function stripHtml(s: string): string {
  return s.replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
}

// ============================================================ Gmail API client
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users';

async function gmailGet<T>(mailbox: string, token: string, path: string): Promise<T> {
  return gmailFetch<T>(`${GMAIL_BASE}/${encodeURIComponent(mailbox)}${path}`, token, { method: 'GET' });
}
async function gmailPost<T>(mailbox: string, token: string, path: string, body: unknown): Promise<T> {
  return gmailFetch<T>(`${GMAIL_BASE}/${encodeURIComponent(mailbox)}${path}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function gmailFetch<T>(url: string, token: string, init: RequestInit): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    if (res.ok) return await res.json() as T;
    if (res.status === 429 || res.status >= 500) {
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    const text = await res.text();
    throw new Error(`Gmail ${res.status}: ${text.slice(0, 300)} (${init.method} ${url})`);
  }
  throw new Error(`Gmail retries exhausted (${init.method} ${url})`);
}

async function listAllThreadIds(mailbox: string, token: string, q: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = `/threads?q=${encodeURIComponent(q)}&maxResults=100` + (pageToken ? `&pageToken=${pageToken}` : '');
    const json = await gmailGet<{ threads?: { id: string }[]; nextPageToken?: string }>(mailbox, token, url);
    for (const t of json.threads ?? []) ids.push(t.id);
    pageToken = json.nextPageToken;
    pages++;
    if (pages > 20) break;                              // soft cap: 2,000 threads on bootstrap
  } while (pageToken);
  return ids;
}

async function listHistory(mailbox: string, token: string, startHistoryId: string): Promise<{
  threadIds: string[]; historyIdAfter: string | null;
}> {
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  let lastHistoryId: string | null = null;
  try {
    do {
      const url = `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const json = await gmailGet<{
        history?: { messages?: { threadId: string }[] }[];
        historyId?: string;
        nextPageToken?: string;
      }>(mailbox, token, url);
      for (const h of json.history ?? []) {
        for (const m of h.messages ?? []) seen.add(m.threadId);
      }
      if (json.historyId) lastHistoryId = json.historyId;
      pageToken = json.nextPageToken;
      pages++;
      if (pages > 50) break;
    } while (pageToken);
  } catch (e) {
    // Google deletes history >7d. Caller will fall through and re-bootstrap
    // next run by clearing last_history_id manually if needed. For now, surface.
    throw new Error(`history.list failed (likely expired startHistoryId): ${(e as Error).message}`);
  }
  return { threadIds: [...seen], historyIdAfter: lastHistoryId };
}

async function ensureLabel(mailbox: string, token: string, name: string): Promise<string | null> {
  const list = await gmailGet<{ labels?: { id: string; name: string }[] }>(mailbox, token, `/labels`);
  const existing = list.labels?.find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmailPost<{ id: string }>(mailbox, token, `/labels`, {
    name, labelListVisibility: 'labelHide', messageListVisibility: 'hide',
  });
  return created.id ?? null;
}
async function applyLabel(mailbox: string, token: string, threadId: string, labelId: string): Promise<void> {
  await gmailPost(mailbox, token, `/threads/${threadId}/modify`, { addLabelIds: [labelId] });
}

// ============================================================ Service-account JWT → OAuth access token
async function getAccessToken(saKey: ServiceAccountKey, delegatedSubject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(saKey.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: SCOPES })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saKey.client_email)
    .setSubject(delegatedSubject)
    .setAudience(saKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token');
  return json.access_token;
}

// ============================================================ Response helper
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
