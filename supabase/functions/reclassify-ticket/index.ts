// On-demand classifier rerun for a single ticket. Called by the "Reclassify"
// button in the admin UI (PR3). Resets is_manually_overridden so the new
// classifier output sticks; subsequent sync runs may then refine further.
//
// Auth: requires the caller's user JWT in the Authorization header (the
// SUPABASE_ANON_KEY by itself is not enough — the function checks
// auth.getUser() returns a real user before mutating anything).
//
// POST body: { ticket_id: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { classify, type Category, type Priority, type ThreadInput } from '../_shared/classifier.ts';
import { llmClassify, sha256Hex } from '../_shared/classifier-llm.ts';

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
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject cron-secret calls — these functions are operator-triggered only.
  if (_caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const body = await req.json().catch(() => ({})) as { ticket_id?: string };
  if (!body.ticket_id) return json({ error: 'ticket_id required' }, 400);

  const { data: ticket, error: tErr } = await admin
    .from('service_tickets')
    .select('id, subject, customer_name, status')
    .eq('id', body.ticket_id)
    .single();
  if (tErr || !ticket) return json({ error: tErr?.message ?? 'ticket not found' }, 404);

  const { data: messages, error: mErr } = await admin
    .from('ticket_messages')
    .select('id, gmail_message_id, direction, sent_at, body_text, snippet')
    .eq('ticket_id', body.ticket_id)
    .order('sent_at', { ascending: true });
  if (mErr) return json({ error: mErr.message }, 500);

  const threadInput: ThreadInput = {
    subject: ticket.subject ?? '',
    customer_name: ticket.customer_name,
    messages: (messages ?? []).map(m => ({
      direction: m.direction as 'inbound' | 'outbound',
      sent_at: m.sent_at ?? new Date().toISOString(),
      body_text: m.body_text ?? m.snippet ?? '',
      snippet: m.snippet ?? undefined,
    })),
  };

  const rules = classify(threadInput);

  // Same fallback flow as the sync function: if rules say 'other', try LLM.
  // No budget gate here — reclassify is one call per invocation.
  let finalPriority: Priority = rules.priority;
  let finalCategory: Category = rules.category;
  let finalSummary = rules.summary;
  let finalNextAction = rules.suggested_next_action;
  let finalStatus = rules.status;
  let method: 'rules' | 'llm' = 'rules';
  let ruleId: string | null = rules.ruleId ?? null;
  let llmHash: string | null = null;
  let llmConfidence: number | null = null;

  if (rules.category === 'other') {
    const lastMsgId = (messages ?? []).at(-1)?.gmail_message_id ?? '';
    llmHash = await sha256Hex(`${body.ticket_id}|${lastMsgId}`);
    const llm = await llmClassify(threadInput);
    if (llm) {
      finalPriority = llm.priority;
      finalCategory = llm.category;
      finalSummary = llm.summary;
      finalNextAction = llm.suggested_next_action;
      finalStatus = undefined;
      llmConfidence = llm.confidence;
      method = 'llm';
      ruleId = null;
    }
  }

  // Reclassify resets manual override — staff clicked "reclassify" so they
  // want the classifier's answer to win.
  const update: Record<string, unknown> = {
    priority: PRIORITY_TO_DB[finalPriority],
    topic: finalCategory,
    summary: finalSummary,
    suggested_next_action: finalNextAction,
    last_classified_at: new Date().toISOString(),
    is_manually_overridden: false,
    classification_confidence: llmConfidence,
  };
  if (finalStatus === 'resolved' && ['new','triaging','waiting_customer'].includes(ticket.status)) {
    update.status = 'resolved';
    update.resolved_at = new Date().toISOString();
  }

  const { error: updErr } = await admin.from('service_tickets').update(update).eq('id', body.ticket_id);
  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500);

  await admin.from('ticket_classification_log').insert({
    ticket_id: body.ticket_id,
    method,
    priority: finalPriority,
    category: finalCategory,
    rule_id: ruleId,
    llm_input_hash: llmHash,
    confidence: llmConfidence,
  });

  return json({
    ok: true,
    result: {
      priority: finalPriority,
      category: finalCategory,
      summary: finalSummary,
      suggested_next_action: finalNextAction,
      method,
    },
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
