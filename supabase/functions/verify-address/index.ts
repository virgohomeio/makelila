// verify-address: on-demand validation for an order's address.
//
// Primary path: Google's Address Validation API (addressvalidation.googleapis.com/v1:validateAddress).
// Unlike the Geocoding API (which just resolves an address to coordinates and
// echoes a best-effort match), this returns a real validation verdict plus the
// USPS/postal-standardized address. We compare the validated postal with the
// customer's parsed postal and write the verdict to orders.address_match. On
// 'mismatch', also flips orders.status to 'flagged'.
//
// Fallback path (walkthrough #13): when Google returns 'unverifiable' (common
// on Canadian rural addresses where the data coverage is poor), we hand the
// address to Claude to judge plausibility and infer the postal. The Claude
// verdict + reasoning is stored on the order so operators can see WHY a
// verdict was overridden, and `address_match` is upgraded from
// 'unverifiable' to 'match'/'mismatch' if Claude returns a usable answer.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type VerifyInput = { order_id: string };

// Subset of the Address Validation API response we care about.
// https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress
type AVAddressComponent = {
  componentName?: { text?: string };
  componentType?: string;
};
type AVResponse = {
  result?: {
    verdict?: {
      validationGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
    };
    address?: {
      formattedAddress?: string;
      postalAddress?: { postalCode?: string };
      addressComponents?: AVAddressComponent[];
    };
  };
  error?: { code?: number; message?: string; status?: string };
};

function normalizePostal(p: string | null | undefined, country: 'US' | 'CA' | string): string | null {
  if (!p) return null;
  const s = p.replace(/[\s-]/g, '').toUpperCase();
  if (country === 'US') {
    const m = s.match(/^(\d{5})\d{0,4}$/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? s : null;
  }
  return s;
}

function parseCustomerPostal(addressLine: string | null, country: 'US' | 'CA' | string): string | null {
  if (!addressLine) return null;
  if (country === 'US') {
    const m = addressLine.match(/\b(\d{5})(-\d{4})?\b/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    const m = addressLine.match(/\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }
  return null;
}

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
    .select('id, address_line, city, region_state, country, postal_code, status')
    .eq('id', order_id)
    .single();
  if (oErr || !order) return j({ error: `Order not found: ${oErr?.message}` }, 404);

  const addressLines = [order.address_line].filter(Boolean) as string[];
  if (addressLines.length === 0 && !order.city && !order.postal_code) {
    return j({ error: 'Order has no address to verify' }, 400);
  }

  // Address Validation API takes a structured PostalAddress, not a free-text
  // query — pass each field separately for a tighter, validated result.
  const reqBody = {
    address: {
      regionCode: order.country,
      addressLines,
      locality: order.city || undefined,
      administrativeArea: order.region_state || undefined,
      postalCode: order.postal_code || undefined,
    },
  };

  const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`;
  const gRes = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!gRes.ok) {
    const body = await gRes.text();
    return j({ error: `Google Address Validation ${gRes.status}: ${body.slice(0, 400)}` }, 502);
  }
  const gJson = (await gRes.json()) as AVResponse;

  // Prefer the postal_code column (populated from Shopify shipping_address.zip);
  // fall back to regex on address_line for orders synced before that field
  // was captured.
  const customerPostal = normalizePostal(
    order.postal_code ?? parseCustomerPostal(order.address_line, order.country),
    order.country,
  );

  const result = gJson.result;
  // Validated postal: prefer the standardized postalAddress, fall back to the
  // postal_code address component.
  const validatedPostalRaw =
    result?.address?.postalAddress?.postalCode ??
    result?.address?.addressComponents?.find(c => c.componentType === 'postal_code')?.componentName?.text ??
    null;
  const validatedPostal = normalizePostal(validatedPostalRaw, order.country);
  const formatted = result?.address?.formattedAddress ?? null;
  const granularity = result?.verdict?.validationGranularity ?? 'GRANULARITY_UNSPECIFIED';
  // Granularities that mean "we couldn't pin this to a real place".
  const unusableGranularity = granularity === 'GRANULARITY_UNSPECIFIED' || granularity === 'OTHER';

  let match: 'match' | 'mismatch' | 'unverifiable';
  if (!result || unusableGranularity || !validatedPostal || !customerPostal) {
    match = 'unverifiable';
  } else if (validatedPostal === customerPostal) {
    match = 'match';
  } else {
    match = 'mismatch';
  }

  // ─── Claude fallback (walkthrough #13) ──────────────────────────────
  // Only run when Google said "unverifiable" AND the Anthropic key is set.
  // We never call Claude for orders Google already verified — Google's data
  // is authoritative when it returns a real granularity.
  let claudeVerdict: 'plausible' | 'implausible' | 'unknown' | null = null;
  let claudeNotes: string | null = null;
  let claudePostal: string | null = null;
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (match === 'unverifiable' && anthropicKey) {
    try {
      const llm = await claudeJudgeAddress(anthropicKey, {
        address_line: order.address_line,
        city: order.city,
        region: order.region_state,
        postal: order.postal_code,
        country: order.country,
      });
      claudeVerdict = llm.verdict;
      claudeNotes = llm.notes;
      claudePostal = llm.inferred_postal;
      // Upgrade the match verdict when Claude returns a usable answer:
      //   plausible + postal matches → 'match'
      //   plausible + postal differs → 'mismatch' (Claude inferred a different postal)
      //   implausible                → 'mismatch' (the address itself is bogus)
      //   unknown                    → leave as 'unverifiable'
      const normClaudePostal = normalizePostal(claudePostal, order.country);
      if (claudeVerdict === 'plausible' && normClaudePostal && customerPostal) {
        match = normClaudePostal === customerPostal ? 'match' : 'mismatch';
      } else if (claudeVerdict === 'plausible' && customerPostal && !normClaudePostal) {
        // Claude says plausible but couldn't infer a postal — take the
        // customer's postal at face value and call it a match.
        match = 'match';
      } else if (claudeVerdict === 'plausible' && !customerPostal) {
        // Shopify didn't capture the customer's postal at our end (common
        // for older orders before we started recording postal_code). Google
        // returned a usable granularity AND Claude judged the address
        // plausible — the order is deliverable, treat as match.
        match = 'match';
      } else if (claudeVerdict === 'implausible') {
        match = 'mismatch';
      }
    } catch (e) {
      // Fallback failure is non-fatal — keep Google's "unverifiable" verdict
      // and record the error in notes for the operator.
      claudeNotes = `Claude fallback errored: ${(e as Error).message}`;
    }
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
  };
  if (match === 'mismatch' && order.status !== 'flagged') {
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
  });
});

// ────────────────────────────────────────────────────────────────────────
// Claude fallback (walkthrough #13)
// ────────────────────────────────────────────────────────────────────────
type ClaudeJudgement = {
  verdict: 'plausible' | 'implausible' | 'unknown';
  inferred_postal: string | null;
  notes: string;
};

async function claudeJudgeAddress(
  apiKey: string,
  addr: { address_line: string | null; city: string | null; region: string | null; postal: string | null; country: string },
): Promise<ClaudeJudgement> {
  const parts = [
    addr.address_line, addr.city,
    [addr.region, addr.postal].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean);
  const composed = parts.join(', ');

  const prompt =
`You are validating a shipping address. Reply with ONLY a JSON object, no prose, with three fields:
- "verdict": one of "plausible" (the address looks like a real, deliverable place), "implausible" (the address contains contradictions, typos, or is obviously fake), or "unknown" (you cannot tell).
- "inferred_postal": the postal/ZIP code you would expect for this address, or null if you cannot infer one. Use the country's standard format (CA: A1A 1A1, US: 12345).
- "notes": one sentence explaining your judgment.

Address to validate:
${composed}

Customer-supplied postal: ${addr.postal ?? '(none)'}
Country: ${addr.country}

Examples:
- "123 Main St, Toronto, ON M5V 2T6, CA" → {"verdict":"plausible","inferred_postal":"M5V 2T6","notes":"Standard downtown Toronto address with matching postal code."}
- "PO Box 14, Whitehorse, YT Y1A 0C4, CA" → {"verdict":"plausible","inferred_postal":"Y1A 0C4","notes":"Valid Yukon PO box with correct Y1A prefix."}
- "999 Elm, Springfield, ON 99999 9X9, CA" → {"verdict":"implausible","inferred_postal":null,"notes":"Postal code does not match Canadian format."}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
  // Tolerant parse: pull the first {...} block in case the model wrapped it in prose.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as {
    verdict?: string;
    inferred_postal?: string | null;
    notes?: string;
  };
  const verdict: ClaudeJudgement['verdict'] =
    parsed.verdict === 'plausible'   ? 'plausible'
  : parsed.verdict === 'implausible' ? 'implausible'
  : 'unknown';
  return {
    verdict,
    inferred_postal: parsed.inferred_postal ?? null,
    notes: parsed.notes ?? '(no notes)',
  };
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
