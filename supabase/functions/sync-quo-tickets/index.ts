// Sync OpenPhone (Quo) SMS conversations into service_tickets + ticket_messages.
// Mirrors the sync-gmail-tickets polling pattern.
//
// One ticket per customer, keyed by quo_conversation_id. Subsequent messages
// on the same conversation append as ticket_messages rows.
//
// Auth: raw API key in Authorization header (no Bearer prefix — OpenPhone spec).
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENPHONE_API_KEY           — rotate before use (previous key leaked 2026-05-27)
//   OPENPHONE_PHONE_NUMBER_IDS  — comma-separated phone-number IDs (Lila Pro Service line only)
//
// ticket_messages dedup: gmail_message_id column is NOT NULL + the upsert conflict key.
// Quo message IDs are stored with a 'quo:' prefix (e.g. 'quo:MSG_xxx') so they satisfy
// the constraint and don't collide with real Gmail IDs.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

// Inline corsHeaders to avoid module-resolution issues at deploy time.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const OPENPHONE_BASE = 'https://api.openphone.com/v1';
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_OWNER_EMAIL = 'junaid@virgohome.io';

// Our own OpenPhone inbox numbers — never use these as the "customer" phone.
// If otherParties[0] is somehow one of these, it means the conversation data
// is malformed and we should fall back to the inbound message sender.
const OWN_INBOX_PHONES = new Set([
  '2899012997',   // Primary inbox
  '8445695452',   // 844-Joy-LILA
  '3658253070',   // LILA Pro Service
]);

// ---- OpenPhone API types ----

type OPMessage = {
  id: string;
  conversationId: string;
  direction: 'incoming' | 'outgoing';
  // 'from' is a reserved word in TS; OpenPhone returns it as 'from'
  from: string;
  to: string[];
  text: string;   // OpenPhone returns message content as 'text', not 'body'
  body?: string;  // kept as optional fallback for safety
  createdAt: string; // ISO 8601
  status?: string;
};

type OPMessagesResponse = {
  data: OPMessage[];
  nextPageToken?: string;
};

type OPConversation = {
  id: string;
  participants: string[]; // E.164 numbers of the other party (not our line)
  lastActivityAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

type OPConversationsResponse = {
  data: OPConversation[];
  nextPageToken?: string;
};

// ---- Customer / unit / order lookup types ----

type CustomerLite = {
  id: string;
  full_name: string | null;
  email: string | null;
};

// ---- Run summary ----

type RunResult = {
  phone_number_id: string;
  ok: boolean;
  conversations_seen: number;
  tickets_created: number;
  tickets_appended: number;
  messages_added: number;
  skipped: number;
  error?: string;
};

// ============================================================ Entry point

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return jsonResponse({ error: `Uncaught: ${msg}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl    = Deno.env.get('SUPABASE_URL');
  const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey         = Deno.env.get('OPENPHONE_API_KEY');
  const phoneNumberIds = (Deno.env.get('OPENPHONE_PHONE_NUMBER_IDS') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject UI-triggered calls — these functions only run from pg_cron.
  if (_caller.kind !== 'cron') {
    return new Response(
      JSON.stringify({ error: 'This function is cron-only — use the X-Cron-Secret header.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  if (!apiKey || phoneNumberIds.length === 0) {
    return jsonResponse({
      skipped: true,
      reason: 'OPENPHONE_API_KEY or OPENPHONE_PHONE_NUMBER_IDS not configured — inert until secrets are set',
    }, 200);
  }

  // ---- Build in-memory lookup caches (once per invocation) ----

  // 1. All customers with non-null phone, keyed by digits-only phone.
  const { data: allCustomers } = await admin
    .from('customers')
    .select('id, full_name, email, phone')
    .not('phone', 'is', null)
    .range(0, 9999);
  const customersByPhone = new Map<string, CustomerLite>();
  for (const c of (allCustomers ?? []) as Array<CustomerLite & { phone: string | null }>) {
    if (c.phone) {
      customersByPhone.set(phoneKey(c.phone), {
        id: c.id,
        full_name: c.full_name,
        email: c.email,
      });
    }
  }

  // 2. Most-recent shipped unit per customer name (lower-trimmed).
  const { data: shippedUnits } = await admin
    .from('units')
    .select('serial, customer_name, shipped_at')
    .eq('status', 'shipped')
    .not('customer_name', 'is', null)
    .order('shipped_at', { ascending: false, nullsFirst: false })
    .range(0, 9999);
  const unitsByCustomerName = new Map<string, string>(); // lower-name → serial
  for (const u of (shippedUnits ?? []) as Array<{ serial: string; customer_name: string | null; shipped_at: string | null }>) {
    if (!u.customer_name) continue;
    const key = u.customer_name.toLowerCase().trim();
    if (!unitsByCustomerName.has(key)) unitsByCustomerName.set(key, u.serial);
  }

  // 3. Most-recent order per customer email (lower-trimmed).
  const { data: orders } = await admin
    .from('orders')
    .select('order_ref, customer_email, placed_at')
    .not('customer_email', 'is', null)
    .order('placed_at', { ascending: false, nullsFirst: false })
    .range(0, 9999);
  const ordersByEmail = new Map<string, string>(); // lower-email → order_ref
  for (const o of (orders ?? []) as Array<{ order_ref: string; customer_email: string | null }>) {
    if (!o.customer_email) continue;
    const key = o.customer_email.toLowerCase().trim();
    if (!ordersByEmail.has(key)) ordersByEmail.set(key, o.order_ref);
  }

  // Determine `since`: max last_message_at across all existing quo tickets.
  // Falls back to DEFAULT_LOOKBACK_DAYS ago when no quo tickets exist yet.
  const { data: sinceRow } = await admin
    .from('service_tickets')
    .select('last_message_at')
    .eq('source', 'quo')
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const since: string = sinceRow?.last_message_at
    ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const results: RunResult[] = [];
  for (const phoneNumberId of phoneNumberIds) {
    const r = await syncPhoneNumber(
      admin, apiKey, phoneNumberId, since,
      customersByPhone, unitsByCustomerName, ordersByEmail,
    );
    results.push(r);
  }

  const ok = results.every(r => r.ok);
  return jsonResponse({ ok, since, results }, ok ? 200 : 207);
}

// ============================================================ Per-phone-number sync

async function syncPhoneNumber(
  admin: SupabaseClient,
  apiKey: string,
  phoneNumberId: string,
  since: string,
  customersByPhone: Map<string, CustomerLite>,
  unitsByCustomerName: Map<string, string>,
  ordersByEmail: Map<string, string>,
): Promise<RunResult> {
  const result: RunResult = {
    phone_number_id: phoneNumberId,
    ok: false,
    conversations_seen: 0,
    tickets_created: 0,
    tickets_appended: 0,
    messages_added: 0,
    skipped: 0,
  };

  try {
    // Step 1: list all conversations for this phone number.
    const allConversations = await fetchAllConversations(apiKey, phoneNumberId);
    const sinceMs = new Date(since).getTime();

    for (const convo of allConversations) {
      // Skip conversations with no activity since `since`.
      const activityTs = convo.lastActivityAt ?? convo.updatedAt ?? convo.createdAt;
      const lastActivity = activityTs ? new Date(activityTs).getTime() : 0;
      if (lastActivity < sinceMs) continue;

      result.conversations_seen++;

      // Step 2: fetch messages for this conversation.
      // participants[] = other-party phone numbers; skip if empty.
      const otherParties = convo.participants.filter(p => p && p.trim());
      if (otherParties.length === 0) continue;

      let msgs: OPMessage[];
      try {
        msgs = await fetchMessagesForConversation(apiKey, phoneNumberId, otherParties);
      } catch (err) {
        result.skipped++;
        // record per-conversation error but keep processing others
        if (!result.error) result.error = (err as Error).message;
        continue;
      }

      // Sort oldest-first for consistent processing.
      msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      const outcome = await upsertConversation(
        admin, convo.id, msgs, otherParties,
        customersByPhone, unitsByCustomerName, ordersByEmail,
      );
      if (outcome === 'created')   result.tickets_created++;
      else if (outcome === 'appended') result.tickets_appended++;
      else result.skipped++;

      result.messages_added += msgs.length; // individual rows inserted (dupes skipped by upsert)
    }

    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }

  return result;
}

// ============================================================ Upsert one conversation

async function upsertConversation(
  admin: SupabaseClient,
  conversationId: string,
  msgs: OPMessage[],
  otherParties: string[],
  customersByPhone: Map<string, CustomerLite>,
  unitsByCustomerName: Map<string, string>,
  ordersByEmail: Map<string, string>,
): Promise<'created' | 'appended' | 'skipped'> {
  if (msgs.length === 0) return 'skipped';

  const firstMsg = msgs[0];
  const lastMsg  = msgs[msgs.length - 1];

  // Prefer otherParties[0] — it is always the "other party" phone number
  // as OpenPhone understands it, regardless of message direction. Only fall
  // back to inboundMsg.from if otherParties is empty or matches one of our
  // own inbox lines (shouldn't happen, but guard against malformed data).
  const quoContactPhone = otherParties.find(p => !OWN_INBOX_PHONES.has(digitsOnly(p).slice(-10)))
    ?? msgs.find(m => m.direction === 'incoming')?.from
    ?? firstMsg.from;
  const customerPhone = quoContactPhone;
  const customer = customersByPhone.get(phoneKey(customerPhone)) ?? null;

  const subject = buildSubject(firstMsg, customerPhone);
  const msgText = firstMsg.text ?? firstMsg.body ?? '';

  // Existing-row lookup. Safe to use .maybeSingle() now that the partial
  // unique index ux_tickets_quo_conv guarantees at most one row per
  // (source='quo', quo_conversation_id) combination — no race window where
  // two rows could both be returned.
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

  // No existing row: insert. New rows land as kind='conversation' so they
  // arrive in the Service Inbox for operator triage rather than the
  // Tickets tab.
  const ticketRow = {
    source:              'quo' as const,
    kind:                'conversation' as const,
    category:            'support',
    status:              'waiting_on_us',
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
    quo_contact_id:      quoContactPhone,
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
    // Concurrent insert won the race; the unique index ux_tickets_quo_conv
    // rejected this insert with 23505. Re-fetch the surviving row and
    // append the messages instead. If the re-fetch itself errors, we
    // surface that secondary error alongside the original 23505 below so
    // debugging isn't misled.
    let raceErr: { message: string } | null = null;
    if (insErr.code === '23505' || /duplicate key/i.test(insErr.message)) {
      const fetched = await admin
        .from('service_tickets')
        .select('id, quo_last_message_id, message_count')
        .eq('quo_conversation_id', conversationId)
        .maybeSingle();
      raceErr = fetched.error ?? null;
      const race = fetched.data;
      if (race) {
        // Note: the recovered row may be from a pre-Inbox cron run with
        // kind='ticket'. That's fine — we only append messages here and
        // do not flip kind back to 'conversation'.
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
      // race fetch returned null (row deleted between collision and
      // re-fetch, RLS, etc.) — fall through to the throw below, which
      // now includes raceErr context if available.
    }
    throw new Error(
      `insert ticket failed (conversation ${conversationId}): ${insErr.message}`
        + (raceErr ? ` (race-recovery query also failed: ${raceErr.message})` : ''),
    );
  }
  if (!ticket) {
    throw new Error(`insert ticket returned no row (conversation ${conversationId})`);
  }

  await insertNewMessages(admin, ticket.id, msgs, null);
  return 'created';
}

// ============================================================ Insert ticket_messages

async function insertNewMessages(
  admin: SupabaseClient,
  ticketId: string,
  msgs: OPMessage[],
  lastSeenMessageId: string | null,
): Promise<number> {
  // Filter to messages after lastSeenMessageId (chronological order guaranteed by caller).
  // If lastSeenMessageId is null, insert all messages (new ticket).
  let toInsert = msgs;
  if (lastSeenMessageId !== null) {
    const lastIdx = msgs.findIndex(m => m.id === lastSeenMessageId);
    // Insert everything after the last seen message. If not found, insert all (safe re-insert;
    // upsert on gmail_message_id will skip real dupes).
    toInsert = lastIdx >= 0 ? msgs.slice(lastIdx + 1) : msgs;
  }
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(m => {
    const text = m.text ?? m.body ?? '';
    return {
      ticket_id:        ticketId,
      // Prefix with 'quo:' — gmail_message_id is NOT NULL and the upsert conflict key;
      // the prefix prevents collision with real Gmail IDs and enables idempotent re-runs.
      gmail_message_id: `quo:${m.id}`,
      direction:        m.direction === 'incoming' ? 'inbound' : 'outbound',
      sender:           m.from || null,
      sent_at:          m.createdAt,
      snippet:          text.slice(0, 200),
      body_text:        text.slice(0, 50_000) || null,
    };
  });

  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { error } = await admin
      .from('ticket_messages')
      .upsert(slice, { onConflict: 'gmail_message_id' });
    if (error) throw new Error(`upsert ticket_messages failed: ${error.message}`);
  }

  return toInsert.length;
}

// ============================================================ OpenPhone API client

async function fetchAllConversations(
  apiKey: string,
  phoneNumberId: string,
): Promise<OPConversation[]> {
  const all: OPConversation[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL(`${OPENPHONE_BASE}/conversations`);
    url.searchParams.set('phoneNumberId', phoneNumberId);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await opFetch<OPConversationsResponse>(apiKey, url.toString());
    for (const c of res.data ?? []) all.push(c);
    pageToken = res.nextPageToken;
    pages++;
    if (pages > 20) break; // soft cap: 2,000 conversations
  } while (pageToken);

  return all;
}

async function fetchMessagesForConversation(
  apiKey: string,
  phoneNumberId: string,
  otherParties: string[],
): Promise<OPMessage[]> {
  const all: OPMessage[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL(`${OPENPHONE_BASE}/messages`);
    url.searchParams.set('phoneNumberId', phoneNumberId);
    for (const p of otherParties) url.searchParams.append('participants[]', p);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await opFetch<OPMessagesResponse>(apiKey, url.toString());
    for (const m of res.data ?? []) all.push(m);
    pageToken = res.nextPageToken;
    pages++;
    if (pages > 10) break; // soft cap: 1,000 messages per conversation
  } while (pageToken);

  return all;
}

async function opFetch<T>(apiKey: string, url: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: {
        // OpenPhone uses raw API key — no Bearer prefix.
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) return await res.json() as T;
    if (res.status === 429 || res.status >= 500) {
      const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    const text = await res.text();
    throw new Error(`OpenPhone ${res.status}: ${text.slice(0, 300)} (GET ${url})`);
  }
  throw new Error(`OpenPhone retries exhausted (GET ${url})`);
}

// ============================================================ Helpers

/** Strip all non-digit characters for phone number comparison. */
function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Phone-match key: last 10 digits. Drops the country-code prefix so that
 *  Quo's "+15192004646" matches customers.phone "519-200-4646" (which is
 *  stored without the leading 1 in our DB). */
function phoneKey(phone: string): string {
  return digitsOnly(phone).slice(-10);
}

/** First line of first message text, truncated to 80 chars; fallback to generic subject. */
function buildSubject(msg: OPMessage, customerPhone: string): string {
  const firstLine = (msg.text ?? msg.body ?? '').split('\n')[0].trim();
  if (firstLine.length > 0) {
    return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + '...';
  }
  return `Quo conversation with ${customerPhone}`;
}

// ============================================================ Response helper

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
