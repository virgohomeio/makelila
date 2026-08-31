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
// then files the result against the posting: it enriches a matching Indeed
// stub, reports a match on someone already on the board as a duplicate
// (changing nothing), or inserts a brand-new full record.
//
// Providers: Claude, then Qwen, then OpenAI — whichever of them have keys
// configured, in that order (override with RESUME_PROVIDER_ORDER). Any HTTP
// or network error from one falls through to the next: the trigger that
// prompted this was a 400 "credit balance is too low", but 401/429/529/5xx
// count too. Neither fallback's chat API takes a document, so the PDF/DOCX
// text is extracted locally (_shared/documentText.ts) and sent inline; both
// speak the same OpenAI-compatible wire format, so they share one client
// (_shared/openaiCompat.ts). A successful reply that isn't valid JSON is NOT
// retried elsewhere — that's a model-output problem, not an availability one.
// Design: docs/superpowers/specs/2026-08-26-hiring-resume-qwen-fallback-design.md
//
// Auth: requires a user JWT (rejects cron-secret callers) — this is
// always triggered by a team member's upload action, never a schedule.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { chatCompletion } from '../_shared/openaiCompat.ts';
import { qwenConfigFromEnv, type ProviderConfig } from '../_shared/qwen.ts';
import { openaiConfigFromEnv } from '../_shared/openai.ts';
import { extractDocumentText } from '../_shared/documentText.ts';
import {
  DEFAULT_PROVIDER_ORDER, PROVIDER_LABELS, parseProviderOrder, pickProviders,
  type LlmProvider,
} from '../_shared/llmProviders.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// The provider chain lives in _shared/llmProviders.ts — match-invoice reads
// PDFs the same way and needs the same fallback. Re-exported here because
// this module is the published surface for the hiring-side tests.
export type ResumeProvider = LlmProvider;
export { DEFAULT_PROVIDER_ORDER, PROVIDER_LABELS, parseProviderOrder, pickProviders };

/** Parses the JSON a model returned for the scoring prompt. Both providers
 *  are told "JSON ONLY" but both occasionally wrap it in a ``` fence, so
 *  strip an optional ```json / ``` opener and ``` closer before parsing.
 *  Throws on anything that still isn't JSON. */
export function parseModelJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(stripped);
}

/** Longest resume text we'll hand to the text-mode fallback. Real resumes
 *  are 3–15k characters; anything past this is a mis-uploaded file, and the
 *  cap keeps one of those from blowing the model's context. */
const MAX_RESUME_TEXT_CHARS = 60_000;

/** Text-mode equivalent of Claude's [document, prompt] content order: the
 *  extracted resume first, then the same scoring prompt. Exported for tests. */
export function buildTextResumeMessage(prompt: string, resumeText: string): string {
  const body = resumeText.length > MAX_RESUME_TEXT_CHARS
    ? `${resumeText.slice(0, MAX_RESUME_TEXT_CHARS)}\n[… truncated …]`
    : resumeText;
  return `Resume (plain text extracted from the candidate's file):\n<<<\n${body}\n>>>\n\n${prompt}`;
}

export type RubricDimension = { dimension: string; weight_pct: number };

export type ParseResumeInput = {
  posting_id: string;
  storage_path: string;   // path within the hiring-resumes bucket
  mime_type: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  source: 'indeed' | 'linkedin' | 'referral' | 'other'
    | 'university_of_waterloo' | 'university_of_toronto' | 'york_university';
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

/** Hiring module leadership gate (finance/admin only) — mirrors
 *  app/src/lib/permissions.ts isLeadership(). authenticate() only checks
 *  profiles.is_internal, which is not enough here: this function inserts
 *  candidate rows via the service-role client, bypassing the client-side
 *  RLS insert restriction, so any internal user could otherwise create
 *  candidate records or burn Claude API calls outside the leadership-only
 *  UI this is meant to back. Returns a 403 Response to short-circuit the
 *  caller when the profile's role isn't leadership, or null to continue.
 *  Exported for unit testing without a live profiles lookup. */
export function requireLeadershipRole(role: string | null | undefined): Response | null {
  if (role === 'finance' || role === 'admin') return null;
  return json({ error: 'This function is restricted to finance/admin (Hiring module leadership).' }, 403);
}

/** An existing candidate row on the posting, as loaded for duplicate
 *  detection. `phone` rides along for the contact backfill below and is not
 *  part of the matching. */
export type ExistingCandidate = {
  id: string;
  full_name: string;
  email: string | null;
  phone?: string | null;
  enrichment_status: 'stub' | 'resume_attached';
};

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/** Finds the candidate a resume already belongs to, anywhere on the posting:
 *  an Indeed stub waiting to be enriched, OR a full record some earlier
 *  upload already created. This used to look at stubs only, so re-uploading
 *  a resume filed the same applicant a second time.
 *
 *  Email decides identity whenever both sides have one. A name-only match is
 *  accepted only when at least one side has no email — two different people
 *  who happen to share a name (and both put an email on their resume) must
 *  never be merged into one record. Stubs win ties: enriching a placeholder
 *  is the useful outcome.
 *
 *  Exported for unit testing — the real caller passes every candidate row for
 *  the target posting_id. */
export function matchExistingCandidate(
  candidates: ExistingCandidate[], extracted: { full_name: string; email: string | null },
): ExistingCandidate | null {
  const email = normalize(extracted.email);
  const name = normalize(extracted.full_name);

  const byEmail = email ? candidates.filter(c => normalize(c.email) === email) : [];
  if (byEmail.length) return preferStub(byEmail);

  const byName = name
    ? candidates.filter(c =>
        normalize(c.full_name) === name &&
        // Both sides carry an email and they differ (an equal pair would have
        // matched above) — same name, different person.
        !(email && normalize(c.email) && normalize(c.email) !== email))
    : [];
  return byName.length ? preferStub(byName) : null;
}

function preferStub(rows: ExistingCandidate[]): ExistingCandidate {
  return rows.find(r => r.enrichment_status === 'stub') ?? rows[0];
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
  const qwen = qwenConfigFromEnv();
  const openai = openaiConfigFromEnv();
  if (!supabaseUrl || !serviceKey) return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  const providers = pickProviders(
    { claude: anthropicKey, qwen: qwen?.apiKey, openai: openai?.apiKey },
    Deno.env.get('RESUME_PROVIDER_ORDER'),
  );
  if (providers.length === 0) {
    return json({ error: 'No resume-parsing provider configured. Set ANTHROPIC_API_KEY, QWEN_API_KEY, or OPENAI_API_KEY via supabase secrets set.' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const { data: callerProfile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', caller.user_id)
    .maybeSingle();
  if (profileErr) return json({ error: `Profile lookup: ${profileErr.message}` }, 500);

  const input = await req.json().catch(() => null) as ParseResumeInput | null;
  if (!input?.posting_id || !input.storage_path || !input.mime_type || !input.source) {
    return json({ error: 'posting_id, storage_path, mime_type, and source are required' }, 400);
  }

  // Leadership (finance/admin) always passes. A non-leadership caller can still
  // upload/score resumes for a SPECIFIC posting if they're an interviewer
  // assigned to it (posting_interviewers) — same rule the app already uses to
  // decide whether they can open that posting in the Hiring module UI
  // (can_view_posting() RLS helper / canViewPosting() in lib/permissions.ts).
  // Scoped to input.posting_id, not "assigned to anything," so an interviewer
  // on Posting A can't burn Claude calls or write candidates on Posting B.
  const leadershipRejection = requireLeadershipRole(callerProfile?.role);
  if (leadershipRejection) {
    const { data: assignment, error: assignmentErr } = await admin
      .from('posting_interviewers')
      .select('id')
      .eq('posting_id', input.posting_id)
      .eq('profile_id', caller.user_id)
      .limit(1);
    if (assignmentErr) return json({ error: `Interviewer check: ${assignmentErr.message}` }, 500);
    if (!assignment || assignment.length === 0) return leadershipRejection;
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
  const fileBytes = await fileBlob.arrayBuffer();

  const prompt = buildScoringPrompt(posting.job_description, posting.screening_rubric as RubricDimension[]);

  // Try each configured provider in order; the first one that answers the
  // HTTP call wins. Collect every failure so a double failure tells the
  // operator which key(s) need attention.
  let textBlock: string | null = null;
  let provider: ResumeProvider | null = null;
  const failures: string[] = [];
  for (const candidate of providers) {
    try {
      textBlock = candidate === 'claude'
        ? await extractWithClaude(anthropicKey!, input.mime_type, fileBytes, prompt)
        : await extractWithTextProvider(candidate, candidate === 'qwen' ? qwen! : openai!, input.mime_type, fileBytes, prompt);
      provider = candidate;
      break;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      failures.push(msg);
      console.warn(`parse-resume-batch: ${candidate} failed — ${msg}`);
    }
  }
  if (textBlock === null || provider === null) {
    // Each message already names its provider, so joining them tells the
    // operator which key(s) need attention without any extra labelling.
    const [primary, ...rest] = failures;
    const error = rest.length ? `${primary}; then ${rest.join('; then ')}` : primary;
    return json({ error, providers_tried: providers }, 502);
  }
  const label = PROVIDER_LABELS[provider];

  let extracted: ExtractedResume;
  try {
    extracted = parseModelJson(textBlock) as ExtractedResume;
  } catch {
    return json({ error: `${label} did not return valid JSON`, raw: textBlock.slice(0, 300), provider }, 502);
  }
  if (!extracted.full_name) return json({ error: `${label} did not extract a full_name from this resume`, provider }, 502);

  // Every candidate on the posting, not just the stubs: a resume the operator
  // has already uploaded is 'resume_attached', and skipping those rows is
  // exactly what made a second upload of the same resume file a second
  // applicant.
  const { data: existing, error: existingErr } = await admin
    .from('candidates')
    .select('id, full_name, email, phone, enrichment_status')
    .eq('posting_id', input.posting_id);
  if (existingErr) return json({ error: `Duplicate check failed: ${existingErr.message}` }, 500);
  const matched = matchExistingCandidate((existing ?? []) as ExistingCandidate[], extracted);

  if (matched && matched.enrichment_status !== 'stub') {
    // This applicant is already on the board from an earlier upload. Insert
    // nothing — that second row is the whole bug — and leave every
    // operator-curated field (scores, stage, decision tags, hand-corrected
    // contact details) untouched. The only writes are contact fields the
    // earlier parse left empty, which cannot clobber anything.
    //
    // The file just uploaded stays in the bucket unreferenced, and the record
    // keeps the resume it already had: a name/email match is not proof the two
    // files are the same document, and silently swapping one candidate's
    // resume for another's would be a worse outcome than a stray object.
    const backfill: Record<string, string> = {};
    if (!matched.email && extracted.email) backfill.email = extracted.email;
    if (!matched.phone && extracted.phone) backfill.phone = extracted.phone;
    if (Object.keys(backfill).length > 0) {
      const { error: backfillErr } = await admin.from('candidates').update(backfill).eq('id', matched.id);
      if (backfillErr) return json({ error: `Contact backfill failed: ${backfillErr.message}` }, 500);
    }

    await admin.from('activity_log').insert({
      user_id: caller.user_id, type: 'candidate_resume_duplicate', entity: matched.full_name,
      entity_type: 'candidate', entity_id: matched.id,
      detail: `Duplicate resume upload — kept the existing record (parsed by ${label})`,
    });
    // The board's name, not the resume's: if an operator corrected the name
    // after the first upload, that is the one they will be looking for.
    return json({
      candidate_id: matched.id,
      duplicate: true,
      full_name: matched.full_name,
      email: matched.email ?? extracted.email,
      phone: matched.phone ?? extracted.phone,
      suggested_scores: extracted.suggested_scores,
      enrichment_status: 'resume_attached',
      provider,
    }, 200);
  }

  // hiring-resumes is a private bucket (20260724130100_hiring_resumes_bucket.sql)
  // — there is no public URL to resolve here. A signed URL would expire, and
  // this column needs to stay valid indefinitely, so we store the raw storage
  // path instead (yes, "resume_url" is a misleading name for a path). Signed-URL
  // generation happens at read time in the Applicants tab UI (Task 11), not here.
  const resumeUrl = input.storage_path;

  if (matched) {
    // A stub (an Indeed notification with no resume attached) — fill it in.
    const { error: updateErr } = await admin.from('candidates').update({
      full_name: extracted.full_name,
      email: extracted.email,
      phone: extracted.phone,
      resume_url: resumeUrl,
      enrichment_status: 'resume_attached',
      suggested_scores: extracted.suggested_scores,
    }).eq('id', matched.id);
    if (updateErr) return json({ error: `Enrich failed: ${updateErr.message}` }, 500);

    await admin.from('activity_log').insert({
      user_id: caller.user_id, type: 'candidate_resume_enriched', entity: extracted.full_name,
      entity_type: 'candidate', entity_id: matched.id, detail: `Parsed by ${label}`,
    });
    return json({ candidate_id: matched.id, duplicate: false, ...extracted, enrichment_status: 'resume_attached', provider }, 200);
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
    entity_type: 'candidate', entity_id: inserted.id, detail: `Parsed by ${label}`,
  });
  return json({ candidate_id: inserted.id, duplicate: false, ...extracted, enrichment_status: 'resume_attached', provider }, 200);
}

/** Primary provider: the resume goes to Claude as a base64 document block.
 *  Returns the text block of the reply, or throws Error("Claude <status>: …")
 *  / Error("Claude request failed: …") so the caller can fall through to the
 *  next provider. */
async function extractWithClaude(
  apiKey: string, mimeType: ParseResumeInput['mime_type'], fileBytes: ArrayBuffer, prompt: string,
): Promise<string> {
  let claudeRes: Response;
  try {
    claudeRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: mimeType, data: arrayBufferToBase64(fileBytes) } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
  } catch (e) {
    throw new Error(`Claude request failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!claudeRes.ok) throw new Error(`Claude ${claudeRes.status}: ${(await claudeRes.text()).slice(0, 300)}`);
  const claudeJson = await claudeRes.json() as { content?: { type: string; text?: string }[] };
  return claudeJson.content?.find(c => c.type === 'text')?.text ?? '';
}

/** Fallback providers: neither chat API takes a document, so extract the text
 *  locally and send it inline. A scanned (image-only) PDF yields no text and
 *  is reported as such rather than sent empty. Throws Error("<Label> …") like
 *  the Claude path so the provider loop can record it.
 *
 *  No max_tokens is set: reasoning models reject the parameter outright, and
 *  capping a JSON reply risks truncating it into something unparseable —
 *  worse than letting a short, tightly-prompted response finish. */
async function extractWithTextProvider(
  provider: Exclude<ResumeProvider, 'claude'>, cfg: ProviderConfig,
  mimeType: ParseResumeInput['mime_type'], fileBytes: ArrayBuffer, prompt: string,
): Promise<string> {
  const label = PROVIDER_LABELS[provider];
  const prefix = provider.toUpperCase();
  let resumeText: string;
  try { resumeText = await extractDocumentText(fileBytes, mimeType); }
  catch (e) { throw new Error(`${label} could not read the file: ${(e as Error)?.message ?? String(e)}`); }
  if (!resumeText) throw new Error(`${label} found no text in this file (scanned/image-only PDF?)`);
  return chatCompletion({
    label, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
    keyEnvVar: `${prefix}_API_KEY`, baseUrlEnvVar: `${prefix}_BASE_URL`, modelEnvVar: `${prefix}_MODEL`,
    system: 'You screen resumes for a hiring team. Output strict JSON only — no markdown, no commentary.',
    user: buildTextResumeMessage(prompt, resumeText),
  });
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
