// Multi-turn issue intake chat. Called by IssueChatPanel.tsx.
//
// Each request carries the full conversation; DeepSeek always replies as
// strict JSON {reply, ready_to_file, issue}. When ready_to_file is true and
// the issue payload validates, this function inserts it directly
// (service-role) and logs it to activity_log — no second round-trip to
// confirm the write happened.
//
// Auth: requires the caller's user JWT (cron-secret not accepted).
// POST body: { messages, product_id, products, knownTeam }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type Severity = typeof SEVERITIES[number];

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type ChatRequest = {
  messages: ChatTurn[];
  product_id: string | null;
  products: { id: string; label: string }[];
  knownTeam: string[];
};

export type FiledIssue = {
  product_id: string;
  title: string;
  severity: Severity;
  tag: string;
  team: string;
  meta: string;
  link: string | null;
  mp_blocker: boolean;
};

type DeepseekTurn = { reply: string; ready_to_file: boolean; issue: unknown };

/** Validates a model-proposed issue against the known product set before
 *  trusting it enough to write to the DB. A malformed or hallucinated
 *  payload returns null — the caller then just continues the conversation
 *  instead of filing garbage. Exported for unit testing. */
export function validateIssue(
  issue: unknown,
  validProductIds: string[],
): FiledIssue | null {
  if (!issue || typeof issue !== 'object') return null;
  const i = issue as Record<string, unknown>;
  if (typeof i.product_id !== 'string' || !validProductIds.includes(i.product_id)) return null;
  if (typeof i.title !== 'string' || !i.title.trim()) return null;
  if (typeof i.meta !== 'string' || !i.meta.trim()) return null;
  if (typeof i.severity !== 'string' || !SEVERITIES.includes(i.severity as Severity)) return null;
  return {
    product_id: i.product_id,
    title: i.title.trim(),
    severity: i.severity as Severity,
    tag: typeof i.tag === 'string' && i.tag.trim() ? i.tag.trim() : 'Other',
    team: typeof i.team === 'string' ? i.team.trim() : '',
    meta: i.meta.trim(),
    link: typeof i.link === 'string' && i.link.trim() ? i.link.trim() : null,
    mp_blocker: i.mp_blocker === true,
  };
}

function buildSystemPrompt(
  products: { id: string; label: string }[],
  knownTeam: string[],
  productHint: string | null,
): string {
  return `You are an issue-intake triage assistant for VCycene/LILA Composter's internal product tracker. A team member is describing a problem in chat; your job is to gather enough information to file it as a ticket on the right product line.

Valid product lines (use the id, not the label):
${products.map(p => `- ${p.id}: ${p.label}`).join('\n')}

Known team members (prefer matching one of these for "accountable person"; if the user names someone else, accept it as-is):
${knownTeam.join(', ')}

${productHint
    ? `The user has pre-selected product "${productHint}" from a dropdown — assume that's the product unless they clearly name a different one in the conversation.`
    : 'No product has been pre-selected — ask which product line if it is not obvious from the description.'}

You need, at minimum, before filing: which product line, a description of the problem (and optionally a link), an accountable person/team, and a severity assessment (critical/high/medium/low — use your judgment based on the description; ask the user only if genuinely ambiguous).

Respond with JSON ONLY, no markdown, matching exactly:
{
  "reply": "<what to say back to the user — a question if more info is needed, or a confirmation once filed>",
  "ready_to_file": <true only once you have product, description, accountable person, and severity>,
  "issue": <null, or once ready_to_file is true: {
    "product_id": "<one of the valid ids above>",
    "title": "<short title, max 80 chars>",
    "severity": "critical" | "high" | "medium" | "low",
    "tag": "<short category tag, e.g. 'Hardware · Latch Mechanism'>",
    "team": "<accountable person/team>",
    "meta": "<full description as given, cleaned up into 1-3 sentences>",
    "link": <string URL if one was given, else null>,
    "mp_blocker": <true only if the user says or implies this blocks mass production, else false>
  }>
}`;
}

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

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const body = await req.json().catch(() => ({})) as Partial<ChatRequest>;
  const messages = body.messages ?? [];
  const products = body.products ?? [];
  const knownTeam = body.knownTeam ?? [];
  const productId = body.product_id ?? null;
  if (!messages.length || !products.length) {
    return json({ error: 'messages and products are required' }, 400);
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    return json({ reply: "Chat isn't configured yet — ask an admin to set DEEPSEEK_API_KEY.", filed: false }, 200);
  }

  const validProductIds = products.map(p => p.id);
  const systemPrompt = buildSystemPrompt(products, knownTeam, productId);

  let deepseekTurn: DeepseekTurn;
  try {
    const res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    deepseekTurn = JSON.parse(text) as DeepseekTurn;
  } catch (err) {
    console.warn('DeepSeek call failed', err);
    return json({ reply: "Sorry, I couldn't reach the classifier — try again in a moment.", filed: false }, 200);
  }

  if (!deepseekTurn.ready_to_file) {
    return json({ reply: deepseekTurn.reply, filed: false }, 200);
  }

  const validated = validateIssue(deepseekTurn.issue, validProductIds);
  if (!validated) {
    return json({ reply: deepseekTurn.reply, filed: false }, 200);
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('display_name')
    .eq('id', caller.user_id)
    .maybeSingle();

  const { data: inserted, error: insertErr } = await admin
    .from('product_issues')
    .insert({
      product_id: validated.product_id,
      title: validated.title,
      severity: validated.severity,
      tag: validated.tag,
      team: validated.team,
      meta: validated.meta,
      link: validated.link,
      mp_blocker: validated.mp_blocker,
      source: 'chat',
      created_by: caller.user_id,
      created_by_name: profile?.display_name ?? caller.email,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    return json({ reply: "I had the details but couldn't save the ticket — try again.", filed: false }, 200);
  }

  await admin.from('activity_log').insert({
    user_id: caller.user_id,
    type: 'product_issue_filed',
    entity: validated.title,
    detail: `${validated.product_id} · ${validated.severity}`,
    entity_type: 'product_issue',
    entity_id: inserted.id,
  });

  return json({
    reply: deepseekTurn.reply,
    filed: true,
    issue: { id: inserted.id, title: validated.title, product_id: validated.product_id },
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
