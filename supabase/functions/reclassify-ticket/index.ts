// On-demand classifier rerun for a single ticket. Called by the "Reclassify"
// button in the admin UI. Always uses Claude Sonnet for full context analysis:
// status, issue_area, root_cause, priority, category, summary, next action.
//
// Auth: requires the caller's user JWT (cron-secret not accepted).
// POST body: { ticket_id: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import type { Priority } from '../_shared/classifier.ts';
import { llmClassify, sha256Hex, type UnitContext, type QuoMessage } from '../_shared/classifier-llm.ts';

const OPENPHONE_BASE = 'https://api.openphone.com/v1';

type OPMessage = {
  id: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  body?: string;
  createdAt: string;
};

/** Fetch the last 20 Quo SMS messages for a customer phone across all configured
 *  phone number IDs. Returns newest-first from the API, we reverse to oldest-first. */
async function fetchLiveQuoMessages(
  customerPhone: string,
  knownIds: Set<string>,
): Promise<QuoMessage[]> {
  const apiKey         = Deno.env.get('OPENPHONE_API_KEY');
  const phoneNumberIds = (Deno.env.get('OPENPHONE_PHONE_NUMBER_IDS') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey || phoneNumberIds.length === 0) return [];

  const all: OPMessage[] = [];
  for (const phoneNumberId of phoneNumberIds) {
    try {
      const url = new URL(`${OPENPHONE_BASE}/messages`);
      url.searchParams.set('phoneNumberId', phoneNumberId);
      url.searchParams.append('participants[]', customerPhone);
      url.searchParams.set('maxResults', '20');
      const res = await fetch(url.toString(), {
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json() as { data?: OPMessage[] };
      for (const m of data.data ?? []) {
        if (!knownIds.has(`quo:${m.id}`)) all.push(m);
      }
    } catch {
      // best-effort — don't fail the whole reclassify if Quo is unreachable
    }
  }

  // Sort oldest-first for the transcript
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return all.map(m => ({
    direction: m.direction,
    text: m.text || m.body || '',
    createdAt: m.createdAt,
  }));
}

const PRIORITY_TO_DB: Record<Priority, 'urgent' | 'high' | 'normal' | 'low'> = {
  urgent: 'urgent',
  high:   'high',
  medium: 'normal',
  low:    'low',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (_caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const body = await req.json().catch(() => ({})) as { ticket_id?: string };
  if (!body.ticket_id) return json({ error: 'ticket_id required' }, 400);

  // Fetch ticket + messages in parallel, then unit context.
  const [ticketRes, messagesRes] = await Promise.all([
    admin
      .from('service_tickets')
      .select('id, subject, customer_name, customer_phone, unit_serial, status, is_manually_overridden')
      .eq('id', body.ticket_id)
      .single(),
    admin
      .from('ticket_messages')
      .select('id, gmail_message_id, direction, sent_at, body_text, snippet')
      .eq('ticket_id', body.ticket_id)
      .order('sent_at', { ascending: true }),
  ]);

  if (ticketRes.error || !ticketRes.data) {
    return json({ error: ticketRes.error?.message ?? 'ticket not found' }, 404);
  }
  if (messagesRes.error) return json({ error: messagesRes.error.message }, 500);

  const ticket   = ticketRes.data;
  const messages = messagesRes.data ?? [];

  // Fetch unit context when serial is available.
  let unitCtx: UnitContext | null = null;
  if (ticket.unit_serial) {
    const { data: unit } = await admin
      .from('units')
      .select('serial, status, batch')
      .eq('serial', ticket.unit_serial)
      .maybeSingle();
    if (unit) {
      // Resolve batch label from batches table for better context.
      const { data: batch } = await admin
        .from('batches')
        .select('version, manufacturer_short')
        .eq('id', unit.batch)
        .maybeSingle();
      unitCtx = {
        serial: unit.serial,
        unit_status: unit.status,
        batch_label: batch?.version ?? batch?.manufacturer_short ?? null,
      };
    }
  }

  // Fetch live Quo messages (messages not yet flushed to DB by sync-quo-tickets).
  const knownQuoIds = new Set(messages.map(m => m.gmail_message_id ?? '').filter(id => id.startsWith('quo:')));
  const quoMessages = ticket.customer_phone
    ? await fetchLiveQuoMessages(ticket.customer_phone, knownQuoIds)
    : [];

  const threadInput = {
    subject: ticket.subject ?? '',
    customer_name: ticket.customer_name,
    messages: messages.map(m => ({
      direction: m.direction as 'inbound' | 'outbound',
      sent_at: m.sent_at ?? new Date().toISOString(),
      body_text: m.body_text ?? m.snippet ?? '',
      snippet: m.snippet ?? undefined,
    })),
  };

  const lastMsgId = messages.at(-1)?.gmail_message_id ?? '';
  const llmHash   = await sha256Hex(`${body.ticket_id}|${lastMsgId}`);
  const llm       = await llmClassify(threadInput, { unit: unitCtx, quoMessages });

  if (!llm) {
    return json({ error: 'Claude classification failed — check ANTHROPIC_API_KEY secret' }, 500);
  }

  // Build ticket update. Status is only overwritten when not manually locked.
  const update: Record<string, unknown> = {
    priority:             PRIORITY_TO_DB[llm.priority],
    topic:                llm.category,
    issue_area:           llm.issue_area,
    root_cause:           llm.root_cause,
    summary:              llm.summary,
    suggested_next_action: llm.suggested_next_action,
    last_classified_at:   new Date().toISOString(),
    is_manually_overridden: false,   // reclassify always resets the override flag
    classification_confidence: llm.confidence,
  };

  // Apply suggested status unless the ticket was manually locked before this call.
  if (!ticket.is_manually_overridden) {
    update.status = llm.status;
    if (llm.status === 'closed' && ticket.status !== 'closed') {
      update.closed_at = new Date().toISOString();
    }
  }

  const { error: updErr } = await admin
    .from('service_tickets')
    .update(update)
    .eq('id', body.ticket_id);
  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500);

  await admin.from('ticket_classification_log').insert({
    ticket_id:        body.ticket_id,
    method:           'llm',
    priority:         llm.priority,
    category:         llm.category,
    issue_area:       llm.issue_area,
    root_cause:       llm.root_cause,
    suggested_status: llm.status,
    rule_id:          null,
    llm_input_hash:   llmHash,
    confidence:       llm.confidence,
  });

  return json({
    ok: true,
    result: {
      priority:             llm.priority,
      category:             llm.category,
      status:               llm.status,
      issue_area:           llm.issue_area,
      root_cause:           llm.root_cause,
      summary:              llm.summary,
      suggested_next_action: llm.suggested_next_action,
      status_applied:       !ticket.is_manually_overridden,
    },
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
