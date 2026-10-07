// verify-address: on-demand validation for an order's shipping address.
//
// The card in Order Review makes three claims to an operator, and this
// function is responsible for all three:
//
//   1. POSTAL — does the code the customer typed match the real one?
//      Google's Address Validation API (addressvalidation.googleapis.com/
//      v1:validateAddress) returns a validation verdict plus the postal-
//      authority-standardized address. On 'mismatch' the order flips to
//      'flagged'.
//
//   2. DWELLING — what are we delivering to: a house, an apartment, a condo,
//      a business, a PO box, a rural route? This used to be a regex over the
//      street line run once at Shopify-sync time and NEVER revisited here, so
//      280 of 287 orders read "house · standard delivery". Google already
//      tells us: USPS `addressRecordType` names the building kind outright,
//      and outside the US a SUB_PREMISE granularity or a `subpremise`
//      component says the same. We now read it and write both the verdict and
//      its provenance, so the card can show a confirmed answer differently
//      from an unverified guess.
//      uspsData is US-only, though, and most orders are Canadian — a Canadian
//      house resolves to PREMISE and stops there, saying a building exists but
//      not what kind. So the model pass below names the building too, recorded
//      as source 'model': weaker than a postal-authority record, stronger than
//      a regex over the street line, and never presented as either.
//
//   3. AREA — urban, suburban or rural. Google exposes no density signal, so
//      a model classifies it. That step is a soft fallback and its failures
//      are now RECORDED (address_area_type_error) rather than swallowed: an
//      area type that silently failed to compute is exactly how a field ends
//      up looking classified when nothing classified it.
//
// A fourth thing falls out of the USPS data and is worth as much as the rest
// combined: dpvConfirmation 'D' means the street is confirmed but the building
// has units and this order names none. A composter ships freight; a driver
// with no unit number leaves it in a lobby or takes it back to the terminal.
// That case now flags the order.
//
// Google is a soft dependency throughout. When it errors (quota, billing, API
// disabled, network) we degrade to 'unverifiable', still run the model pass,
// and tell the operator the verdict was downgraded for an infra reason rather
// than because the address is bad.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { chatCompletion } from '../_shared/openaiCompat.ts';
import { qwenConfigFromEnv } from '../_shared/qwen.ts';
import { openaiConfigFromEnv } from '../_shared/openai.ts';
import {
  PROVIDER_LABELS, chainFailures, jsonFromModelText, pickProviders,
  type LlmProvider,
} from '../_shared/llmProviders.ts';
import {
  normalizePostal, parsePostalFromText, comparePostal,
  guessDwellingFromText, dwellingFromValidation, dwellingFromModelLabel,
  unitStatusFromValidation, areaTypeFromPostal,
  type AVResponse, type AVResult, type Dwelling, type DwellingSource,
  type AreaType, type UnitStatus,
} from '../_shared/addressClassify.ts';

type VerifyInput = { order_id: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey      = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!supabaseUrl || !serviceKey) {
    return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  if (!apiKey) {
    return j({ error: 'GOOGLE_MAPS_API_KEY not configured. Set it via supabase secrets set.' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject cron-secret calls — these functions are operator-triggered only.
  if (_caller.kind !== 'user') {
    return new Response(
      JSON.stringify({ error: 'This function requires an operator JWT — cron-secret not accepted.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  const { order_id } = (await req.json()) as VerifyInput;
  if (!order_id) return j({ error: 'order_id required' }, 400);

  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('id, address_line, address_line2, city, region_state, country, postal_code, status, address_verdict, address_verdict_source')
    .eq('id', order_id)
    .single();
  if (oErr || !order) return j({ error: `Order not found: ${oErr?.message}` }, 404);

  const addressLines = [order.address_line, order.address_line2].filter(Boolean) as string[];
  if (addressLines.length === 0 && !order.city && !order.postal_code) {
    return j({ error: 'Order has no address to verify' }, 400);
  }

  // The Address Validation API takes a structured PostalAddress, not a
  // free-text query. Both address lines go in: the unit number lives in the
  // second one, and it's the difference between Google resolving a building
  // and Google resolving a specific unit within it.
  //
  // enableUspsCass is what makes `uspsData` — dpvConfirmation and
  // addressRecordType, our best dwelling and missing-unit signals — appear in
  // the response at all. It is US/PR-only and errors elsewhere, so it is set
  // per-country rather than always.
  const reqBody: Record<string, unknown> = {
    address: {
      regionCode: order.country,
      addressLines,
      locality: order.city || undefined,
      administrativeArea: order.region_state || undefined,
      postalCode: order.postal_code || undefined,
    },
  };
  if (order.country === 'US') reqBody.enableUspsCass = true;

  let gJson: AVResponse | null = null;
  let googleError: string | null = null;
  try {
    const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`;
    const gRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    if (!gRes.ok) {
      googleError = `Google Address Validation ${gRes.status}: ${(await gRes.text()).slice(0, 300)}`;
    } else {
      gJson = (await gRes.json()) as AVResponse;
    }
  } catch (e) {
    googleError = `Google Address Validation request failed: ${(e as Error).message}`;
  }

  const result: AVResult | null = gJson?.result ?? null;

  // ── 1. Postal ─────────────────────────────────────────────────────────
  // Prefer the postal_code column (populated from Shopify shipping_address.zip);
  // fall back to a regex over address_line for orders synced before that field
  // was captured.
  const customerPostal = normalizePostal(
    order.postal_code ?? parsePostalFromText(order.address_line, order.country),
    order.country,
  );
  const validatedPostalRaw =
    result?.address?.postalAddress?.postalCode ??
    result?.address?.addressComponents?.find(c => c.componentType === 'postal_code')?.componentName?.text ??
    null;
  const validatedPostal = normalizePostal(validatedPostalRaw, order.country);
  const granularity = result?.verdict?.validationGranularity ?? null;
  const formatted = result?.address?.formattedAddress ?? null;

  let match = comparePostal(customerPostal, validatedPostal, granularity);

  // ── 2. Dwelling ───────────────────────────────────────────────────────
  // Only overwrite the sync-time guess when Google actually gave us evidence.
  // A null here keeps the existing verdict AND its 'sync-guess' provenance, so
  // an unconfirmed address never launders itself into a confirmed one.
  const googleDwelling: Dwelling | null = dwellingFromValidation(result);
  // Both are `let`: the model pass below can still name the building when
  // Google's response carried no evidence for it, which outside the US is most
  // of the time. An operator's own verdict is overwritten by neither — it used
  // to lose to Google, which is backwards. They have spoken to the customer.
  const operatorSet = order.address_verdict_source === 'manual';
  let dwelling: Dwelling = googleDwelling
    ?? (order.address_verdict as Dwelling | null)
    ?? guessDwellingFromText(order.address_line, order.address_line2, order.postal_code);
  let dwellingSource: DwellingSource = googleDwelling ? 'google' : 'sync-guess';
  if (operatorSet) {
    dwelling = order.address_verdict as Dwelling;
    dwellingSource = 'manual';
  }

  const unitStatus: UnitStatus = unitStatusFromValidation(result, order.address_line2);

  // ── 3. Area type ──────────────────────────────────────────────────────
  let areaType: AreaType | null = null;
  let areaTypeError: string | null = null;
  let claudeVerdict: 'plausible' | 'implausible' | 'unknown' | null = null;
  let claudeNotes: string | null = null;
  let claudePostal: string | null = null;

  const chain = pickProviders(
    {
      claude: Deno.env.get('ANTHROPIC_API_KEY'),
      qwen:   Deno.env.get('QWEN_API_KEY'),
      openai: Deno.env.get('OPENAI_API_KEY'),
    },
    Deno.env.get('LLM_PROVIDER_ORDER'),
  );

  if (chain.length === 0) {
    areaTypeError = 'No LLM provider configured (ANTHROPIC_API_KEY / QWEN_API_KEY / OPENAI_API_KEY all unset) — area type not classified.';
  } else {
    try {
      const llm = await judgeAddress(chain, {
        address_line: order.address_line,
        address_line2: order.address_line2,
        city: order.city,
        region: order.region_state,
        postal: order.postal_code,
        country: order.country,
        // Google's standardized address is the better input when we have it —
        // it resolves abbreviations and corrects the city ("Bay Harbor Is" →
        // "Bay Harbor Islands"), which is exactly what a density judgement
        // hinges on.
        google_formatted: formatted,
      });
      areaType = llm.area_type;
      if (!areaType) {
        areaTypeError = 'The model could not tell the area type for this address.';
      }
      // Fill the building type only where nothing better exists. Precedence is
      // manual > google > model > sync-guess, and each is recorded as what it
      // is — the card styles a model reading differently from a postal
      // authority's record, so an operator can tell them apart.
      if (!googleDwelling && !operatorSet && llm.dwelling) {
        dwelling = llm.dwelling;
        dwellingSource = 'model';
      }
      // The plausibility half is only USED to break a tie Google couldn't:
      // Google stays authoritative whenever it returned a real granularity.
      if (match === 'unverifiable') {
        claudeVerdict = llm.verdict;
        claudeNotes = llm.notes;
        claudePostal = llm.inferred_postal;
        const normClaudePostal = normalizePostal(claudePostal, order.country);
        if (claudeVerdict === 'plausible' && normClaudePostal && customerPostal) {
          match = normClaudePostal === customerPostal ? 'match' : 'mismatch';
        } else if (claudeVerdict === 'plausible') {
          // Plausible, but no postal to compare on one side or the other.
          // Deliverable as far as anyone can tell — treat as a match.
          match = 'match';
        } else if (claudeVerdict === 'implausible') {
          match = 'mismatch';
        }
      }
    } catch (e) {
      // Non-fatal, but no longer silent. Before this, a model outage left the
      // area type simply un-updated and the operator saw a stale or absent
      // value with no indication anything had failed.
      areaTypeError = `Area-type classification failed: ${(e as Error).message}`;
      if (match === 'unverifiable') claudeNotes = areaTypeError;
    }
  }

  // Deterministic backup: the Canada-Post rural rule. Urban vs suburban cannot
  // be told from a postal code, so anything it can't establish stays NULL —
  // unclassified is an honest state, a manufactured 'suburban' is not.
  if (!areaType) {
    areaType = areaTypeFromPostal(order.postal_code, order.country);
    if (areaType) areaTypeError = null;
  }

  if (googleError && match === 'unverifiable' && !claudeNotes) {
    claudeNotes = `Address validation unavailable: ${googleError}`;
  }

  const patch: Record<string, unknown> = {
    address_verified_at: new Date().toISOString(),
    address_match: match,
    address_google_formatted: formatted,
    address_google_postal: validatedPostalRaw,
    address_customer_postal: customerPostal,
    address_claude_verdict: claudeVerdict,
    address_claude_notes:   claudeNotes,
    address_claude_postal:  claudePostal,
    address_verdict:        dwelling,
    address_verdict_source: dwellingSource,
    address_unit_status:    unitStatus,
    address_validation_granularity: granularity,
    address_usps_dpv:         result?.uspsData?.dpvConfirmation ?? null,
    address_usps_record_type: result?.uspsData?.addressRecordType ?? null,
    address_is_residential:   result?.metadata?.residential ?? null,
    address_is_business:      result?.metadata?.business ?? null,
    address_area_type_error:  areaTypeError,
  };
  // Only write area_type when we determined one, so a verify never blanks a
  // value an operator set by hand. Source 'verified' marks it as established
  // by this step (vs 'auto' from the postal rule, or 'manual').
  if (areaType) {
    patch.area_type = areaType;
    patch.area_type_source = 'verified';
  }

  // Both of these mean the shipment cannot go out as it stands: a wrong postal
  // code, or a multi-unit building with no unit number. Same treatment.
  const blocking = match === 'mismatch' || unitStatus === 'missing';
  if (blocking && order.status !== 'flagged') {
    patch.status = 'flagged';
  }

  const { error: upErr } = await admin.from('orders').update(patch).eq('id', order_id);
  if (upErr) return j({ error: `DB update failed: ${upErr.message}` }, 500);

  return j({
    match,
    customer_postal: customerPostal,
    google_postal: validatedPostalRaw,
    google_formatted: formatted,
    claude_verdict: claudeVerdict,
    claude_notes: claudeNotes,
    claude_postal: claudePostal,
    area_type: areaType,
    area_type_error: areaTypeError,
    dwelling,
    dwelling_source: dwellingSource,
    unit_status: unitStatus,
    granularity,
    google_error: googleError,
  });
});

// ────────────────────────────────────────────────────────────────────────
// Model pass: area-type classification, plus plausibility as a tie-breaker
// ────────────────────────────────────────────────────────────────────────
type Judgement = {
  verdict: 'plausible' | 'implausible' | 'unknown';
  inferred_postal: string | null;
  area_type: AreaType | null;
  /** The building the model named, already mapped onto our vocabulary. null
   *  when it said "unknown" or something we don't recognise. */
  dwelling: Dwelling | null;
  notes: string;
};

const SYSTEM = 'You validate shipping addresses and classify delivery areas. Output strict JSON only — no markdown, no commentary.';

function buildPrompt(addr: {
  address_line: string | null; address_line2: string | null; city: string | null;
  region: string | null; postal: string | null; country: string; google_formatted: string | null;
}): string {
  const composed = [
    addr.address_line, addr.address_line2, addr.city,
    [addr.region, addr.postal].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean).join(', ');

  return `Reply with ONLY a JSON object, no prose, with five fields:
- "verdict": one of "plausible" (a real, deliverable place), "implausible" (contradictions, typos, or obviously fake), or "unknown" (you cannot tell).
- "inferred_postal": the postal/ZIP code you would expect for this address, or null. Use the country's standard format (CA: A1A 1A1, US: 12345).
- "area_type": classify the DELIVERY AREA as "urban" (dense city core or major-city neighbourhood), "suburban" (residential area around a city, or a mid-size town), or "rural" (countryside, village, or remote low-density area). Judge the actual neighbourhood, not the metro area it belongs to — a downtown high-rise is urban even in a small city. Use null ONLY if you genuinely cannot place the address.
- "building_type": what kind of building stands at this address — one of "house" (a detached house, townhouse or duplex), "apartment" (a multi-unit residential building), "condo" (a condominium tower, typically with a concierge or loading dock), "business" (a commercial or office address), "po_box", or "unknown" if you genuinely cannot tell. Judge the building at this street address, not the neighbourhood around it.
- "notes": one sentence explaining your judgment.

Address as the customer entered it:
${composed}
${addr.google_formatted ? `\nSame address, standardized by the postal authority:\n${addr.google_formatted}` : ''}
Customer-supplied postal: ${addr.postal ?? '(none)'}
Country: ${addr.country}

Examples:
- "123 Main St, Toronto, ON M5V 2T6, CA" → {"verdict":"plausible","inferred_postal":"M5V 2T6","area_type":"urban","building_type":"condo","notes":"Standard downtown Toronto address; M5V is dense condo towers."}
- "925 Bute St, 21, Vancouver, BC V6E 1Y7, CA" → {"verdict":"plausible","inferred_postal":"V6E 1Y7","area_type":"urban","building_type":"apartment","notes":"Unit 21 in a West End apartment building, a dense downtown Vancouver neighbourhood."}
- "47 Maple Cres, Oakville, ON L6H 3R1, CA" → {"verdict":"plausible","inferred_postal":"L6H 3R1","area_type":"suburban","building_type":"house","notes":"Residential street of detached houses in a suburb west of Toronto."}
- "PO Box 14, Whitehorse, YT Y1A 0C4, CA" → {"verdict":"plausible","inferred_postal":"Y1A 0C4","area_type":"rural","building_type":"po_box","notes":"Valid Yukon PO box with correct Y1A prefix; remote territory."}
- "999 Elm, Springfield, ON 99999 9X9, CA" → {"verdict":"implausible","inferred_postal":null,"area_type":null,"building_type":"unknown","notes":"Postal code does not match Canadian format."}`;
}

/** Tries each configured provider in order. A provider that errors (HTTP,
 *  network, no credit) falls through to the next — the Anthropic account
 *  running out of credit is exactly what this chain exists for. A provider
 *  that answers with unparseable JSON is NOT retried elsewhere: that's a
 *  model-output problem, not an availability one. Throws with every failure
 *  chained when nothing got through, so the caller can record which key needs
 *  attention. */
async function judgeAddress(
  providers: LlmProvider[],
  addr: Parameters<typeof buildPrompt>[0],
): Promise<Judgement> {
  const prompt = buildPrompt(addr);
  const failures: string[] = [];
  for (const provider of providers) {
    let reply: string;
    try {
      reply = provider === 'claude'
        ? await claudeChat(Deno.env.get('ANTHROPIC_API_KEY')!, prompt)
        : await compatChat(provider, prompt);
    } catch (e) {
      failures.push((e as Error)?.message ?? String(e));
      continue;
    }
    return parseJudgement(reply, PROVIDER_LABELS[provider]);
  }
  throw new Error(chainFailures(failures));
}

async function claudeChat(apiKey: string, prompt: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    throw new Error(`Claude request failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
}

async function compatChat(provider: Exclude<LlmProvider, 'claude'>, prompt: string): Promise<string> {
  const cfg = provider === 'qwen' ? qwenConfigFromEnv() : openaiConfigFromEnv();
  if (!cfg) throw new Error(`${PROVIDER_LABELS[provider]} is not configured.`);
  const prefix = provider.toUpperCase();
  return chatCompletion({
    label: PROVIDER_LABELS[provider],
    apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
    keyEnvVar: `${prefix}_API_KEY`, baseUrlEnvVar: `${prefix}_BASE_URL`, modelEnvVar: `${prefix}_MODEL`,
    system: SYSTEM,
    user: prompt,
    maxTokens: 256,
  });
}

/** Coerces a model reply into a Judgement. An unrecognised verdict becomes
 *  'unknown' and an unrecognised area type becomes null — a bad parse must
 *  read as "not established", never as a value. */
export function parseJudgement(reply: string, label = 'Model'): Judgement {
  let p: Record<string, unknown>;
  try { p = jsonFromModelText(reply); }
  catch (e) { throw new Error(`${label}: ${(e as Error)?.message ?? String(e)}`); }
  const verdict: Judgement['verdict'] =
    p.verdict === 'plausible'   ? 'plausible'
  : p.verdict === 'implausible' ? 'implausible'
  : 'unknown';
  const area_type: AreaType | null =
    p.area_type === 'urban'    ? 'urban'
  : p.area_type === 'suburban' ? 'suburban'
  : p.area_type === 'rural'    ? 'rural'
  : null;
  const postal = typeof p.inferred_postal === 'string' && p.inferred_postal.trim()
    ? p.inferred_postal.trim() : null;
  return {
    verdict,
    inferred_postal: postal,
    area_type,
    dwelling: dwellingFromModelLabel(typeof p.building_type === 'string' ? p.building_type : null),
    notes: typeof p.notes === 'string' && p.notes.trim() ? p.notes.trim() : '(no notes)',
  };
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
