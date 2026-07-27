//
// Lets a job posting's rubric be authored from its JD instead of by hand
// (PRD §4.15). Called from the Postings tab's "Suggest from JD" button.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

export type RubricDimension = { dimension: string; weight_pct: number };

/** Validates a Claude-proposed rubric: non-empty array, every entry has a
 *  non-empty dimension label and a positive weight, weights sum to 100
 *  (within floating-point tolerance). Exported for unit testing. */
export function validateRubric(rubric: unknown): RubricDimension[] | null {
  if (!Array.isArray(rubric) || rubric.length === 0) return null;
  const parsed: RubricDimension[] = [];
  let total = 0;
  for (const entry of rubric) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.dimension !== 'string' || !e.dimension.trim()) return null;
    if (typeof e.weight_pct !== 'number' || e.weight_pct <= 0) return null;
    parsed.push({ dimension: e.dimension.trim(), weight_pct: e.weight_pct });
    total += e.weight_pct;
  }
  if (Math.abs(total - 100) > 0.5) return null;
  return parsed;
}

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
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not configured.' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);
  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const { job_description } = await req.json().catch(() => ({})) as { job_description?: string };
  if (!job_description?.trim()) return json({ error: 'job_description is required' }, 400);

  const claudeRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Propose 3-5 weighted screening dimensions for this job posting, with weights summing to exactly 100. Respond with JSON ONLY: an array of {"dimension": "...", "weight_pct": <number>}.\n\nJob description:\n${job_description}`,
      }],
    }),
  });
  if (!claudeRes.ok) return json({ error: `Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}` }, 502);
  const claudeJson = await claudeRes.json() as { content?: { type: string; text?: string }[] };
  const textBlock = claudeJson.content?.find(c => c.type === 'text')?.text ?? '';

  let proposed: unknown;
  try { proposed = JSON.parse(textBlock.trim().replace(/^```json\n?|```$/g, '')); }
  catch { return json({ error: 'Claude did not return valid JSON', raw: textBlock.slice(0, 300) }, 502); }

  const rubric = validateRubric(proposed);
  if (!rubric) return json({ error: 'Claude returned an invalid rubric (weights must sum to 100)', raw: proposed }, 502);

  return json({ rubric }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
