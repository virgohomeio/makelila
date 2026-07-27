// Primary path to a full candidate record (PRD §4.15) — Indeed's
// notification emails never attach the resume (verified against real
// inbox data, see sync-hiring-applications), so this is where the real
// resume file, real contact info, and a JD-grounded auto-score actually
// enter makeLILA. Called once per uploaded file from the Applicants tab's
// batch uploader.
//
// Flow: caller uploads the PDF/DOCX to the hiring-resumes bucket first
// (client-side, via lib/hiring.ts) and passes the resulting storage path
// here. This function downloads it, sends it to Claude as a document
// content block for {name, email, phone} extraction AND a JD-grounded
// rubric score (unconditional — no opt-in toggle, per product decision),
// then either enriches a matching stub row (name match within the same
// posting) or inserts a brand-new full record.
//
// Auth: requires a user JWT (rejects cron-secret callers) — this is
// always triggered by a team member's upload action, never a schedule.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

export type RubricDimension = { dimension: string; weight_pct: number };

export type ParseResumeInput = {
  posting_id: string;
  storage_path: string;   // path within the hiring-resumes bucket
  mime_type: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  source: 'indeed' | 'linkedin' | 'referral' | 'other';
};

type ExtractedResume = {
  full_name: string;
  email: string | null;
  phone: string | null;
  suggested_scores: Record<string, number>;
};

/** Builds the prompt sent to Claude alongside the resume document. Grounds
 *  the score in the actual JD text (not just rubric dimension labels) per
 *  the product decision to make auto-scoring automatic and JD-driven.
 *  Exported for unit testing without a live Claude call. */
export function buildScoringPrompt(jobDescription: string, rubric: RubricDimension[]): string {
  return `You are screening a resume against a specific job posting for VCycene/LILA Composter.

Job description:
${jobDescription}

Score this candidate against each of the following weighted dimensions, using a 1-5 scale (5 = excellent fit):
${rubric.map(r => `- ${r.dimension} (weight ${r.weight_pct}%)`).join('\n')}

Extract the candidate's real contact info from the resume itself (not any cover-letter boilerplate).

Respond with JSON ONLY, matching exactly:
{
  "full_name": "<candidate's full name as it appears on the resume>",
  "email": "<email found on the resume, or null>",
  "phone": "<phone found on the resume, or null>",
  "suggested_scores": { "<dimension>": <1-5 integer>, ... one entry per dimension listed above }
}`;
}

/** Case-insensitive exact-name match against a posting's existing stub
 *  rows. Exported for unit testing — the real caller passes rows already
 *  scoped to enrichment_status='stub' for the target posting_id. */
export function matchExistingStub(
  candidates: { id: string; full_name: string }[], extractedName: string,
): string | null {
  const target = extractedName.trim().toLowerCase();
  const match = candidates.find(c => c.full_name.trim().toLowerCase() === target);
  return match?.id ?? null;
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
  if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not configured. Set it via supabase secrets set.' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const input = await req.json().catch(() => null) as ParseResumeInput | null;
  if (!input?.posting_id || !input.storage_path || !input.mime_type || !input.source) {
    return json({ error: 'posting_id, storage_path, mime_type, and source are required' }, 400);
  }

  const { data: posting, error: postingErr } = await admin
    .from('job_postings')
    .select('job_description, screening_rubric')
    .eq('id', input.posting_id)
    .single();
  if (postingErr || !posting) return json({ error: `Posting not found: ${postingErr?.message}` }, 404);
  if (!posting.job_description) {
    return json({ error: 'This posting has no job_description set — add one before scoring resumes against it.' }, 400);
  }

  const { data: fileBlob, error: dlErr } = await admin.storage.from('hiring-resumes').download(input.storage_path);
  if (dlErr || !fileBlob) return json({ error: `Resume download failed: ${dlErr?.message}` }, 500);
  const fileB64 = arrayBufferToBase64(await fileBlob.arrayBuffer());

  const prompt = buildScoringPrompt(posting.job_description, posting.screening_rubric as RubricDimension[]);

  const claudeRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: input.mime_type, data: fileB64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!claudeRes.ok) return json({ error: `Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}` }, 502);
  const claudeJson = await claudeRes.json() as { content?: { type: string; text?: string }[] };
  const textBlock = claudeJson.content?.find(c => c.type === 'text')?.text ?? '';

  let extracted: ExtractedResume;
  try {
    extracted = JSON.parse(textBlock.trim().replace(/^```json\n?|```$/g, '')) as ExtractedResume;
  } catch {
    return json({ error: 'Claude did not return valid JSON', raw: textBlock.slice(0, 300) }, 502);
  }
  if (!extracted.full_name) return json({ error: 'Claude did not extract a full_name from this resume' }, 502);

  const { data: stubs } = await admin
    .from('candidates')
    .select('id, full_name')
    .eq('posting_id', input.posting_id)
    .eq('enrichment_status', 'stub');
  const matchedId = matchExistingStub(stubs ?? [], extracted.full_name);

  // hiring-resumes is a private bucket (20260724130100_hiring_resumes_bucket.sql)
  // — there is no public URL to resolve here. A signed URL would expire, and
  // this column needs to stay valid indefinitely, so we store the raw storage
  // path instead (yes, "resume_url" is a misleading name for a path). Signed-URL
  // generation happens at read time in the Applicants tab UI (Task 11), not here.
  const resumeUrl = input.storage_path;

  if (matchedId) {
    const { error: updateErr } = await admin.from('candidates').update({
      full_name: extracted.full_name,
      email: extracted.email,
      phone: extracted.phone,
      resume_url: resumeUrl,
      enrichment_status: 'resume_attached',
      suggested_scores: extracted.suggested_scores,
    }).eq('id', matchedId);
    if (updateErr) return json({ error: `Enrich failed: ${updateErr.message}` }, 500);

    await admin.from('activity_log').insert({
      user_id: caller.user_id, type: 'candidate_resume_enriched', entity: extracted.full_name,
      entity_type: 'candidate', entity_id: matchedId,
    });
    return json({ candidate_id: matchedId, ...extracted, enrichment_status: 'resume_attached' }, 200);
  }

  const { data: inserted, error: insertErr } = await admin.from('candidates').insert({
    posting_id: input.posting_id,
    full_name: extracted.full_name,
    email: extracted.email,
    phone: extracted.phone,
    source: input.source,
    resume_url: resumeUrl,
    ingested_via: 'manual_upload',
    enrichment_status: 'resume_attached',
    suggested_scores: extracted.suggested_scores,
  }).select('id').single();
  if (insertErr || !inserted) return json({ error: `Insert failed: ${insertErr?.message}` }, 500);

  await admin.from('activity_log').insert({
    user_id: caller.user_id, type: 'candidate_uploaded', entity: extracted.full_name,
    entity_type: 'candidate', entity_id: inserted.id,
  });
  return json({ candidate_id: inserted.id, ...extracted, enrichment_status: 'resume_attached' }, 200);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
