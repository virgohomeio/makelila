// extract-shipping-invoice: read a carrier's shipping invoice (UPS, Freightcom,
// FedEx, …) the operator just picked in the shipping-invoice form, and return
// the header fields so the form can prefill them. Nothing is stored here — the
// operator reviews/edits the prefilled values and the normal upload saves them.
//
// Body: { file_base64, mime_type, file_name }
// Reply: { fields: { carrier, invoice_number, invoice_date, order_number,
//                    ship_to_city, ship_to_postal }, provider, extract_error }
//
// Extraction is two-layered, mirroring match-invoice:
//   1. Deterministic regex over the PDF text (always runs when text exists).
//   2. The LLM chain (Claude document/image → Qwen → OpenAI on the text) —
//      its answer wins field-by-field over the regex guess.
// Every failure is non-fatal: whatever was found is returned with the reason
// in extract_error, and the operator types the rest.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { chatCompletion } from '../_shared/openaiCompat.ts';
import { qwenConfigFromEnv, type ProviderConfig } from '../_shared/qwen.ts';
import { openaiConfigFromEnv } from '../_shared/openai.ts';
import { extractDocumentText, PDF_MIME } from '../_shared/documentText.ts';
import {
  PROVIDER_LABELS, chainFailures, jsonFromModelText, pickProviders,
  type LlmProvider,
} from '../_shared/llmProviders.ts';

type Input = { file_base64: string; mime_type?: string; file_name?: string };

export type ShippingFields = {
  carrier: string | null;
  invoice_number: string | null;
  invoice_date: string | null;     // YYYY-MM-DD
  order_number: string | null;     // digits of a Shopify order # if printed
  ship_to_city: string | null;
  ship_to_postal: string | null;
};

const EMPTY: ShippingFields = {
  carrier: null, invoice_number: null, invoice_date: null,
  order_number: null, ship_to_city: null, ship_to_postal: null,
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_TEXT_CHARS = 40_000;

const PROMPT =
`You are reading a SHIPPING CARRIER invoice or shipment receipt (UPS, Freightcom/ClickShip, FedEx, Canpar, Purolator, Canada Post, USPS, Goorooship, etc.). Reply with ONLY a JSON object, no prose, with these fields:
- "carrier": the carrier / shipping company that issued the invoice, e.g. "UPS", "Freightcom", "FedEx". Null if unclear.
- "invoice_number": the invoice number (or order/shipment number on a receipt) as a string. NOT a tracking number unless nothing else is shown. Null if absent.
- "invoice_date": the invoice date as YYYY-MM-DD. Null if absent.
- "order_number": a Shopify-style order number if one appears as a reference (e.g. "#1192" or "Ref: 1192" → "1192"). Digits only. Null if absent.
- "ship_to_city": the consignee / ship-to city, or null.
- "ship_to_postal": the consignee / ship-to postal or ZIP code, or null.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  try { const caller = await authenticate(req, admin);
    if (caller.kind !== 'user') return j({ error: 'Operator JWT required.' }, 403);
  } catch (e) { if (e instanceof Response) return e; throw e; }

  const body = (await req.json()) as Input;
  if (!body?.file_base64) return j({ error: 'file_base64 required' }, 400);
  const mime = (body.mime_type || PDF_MIME).toLowerCase();
  const bytes = bytesFromBase64(body.file_base64);

  let text = '';
  if (mime === PDF_MIME) {
    try { text = await extractDocumentText(bytes, PDF_MIME); } catch { /* scanned PDF */ }
  }

  let fields: ShippingFields = { ...EMPTY, ...regexFields(`${body.file_name ?? ''}\n${text}`) };
  let provider: LlmProvider | null = null;
  let extractError: string | null = null;

  const claudeKey = Deno.env.get('ANTHROPIC_API_KEY') || undefined;
  const qwen = qwenConfigFromEnv();
  const openai = openaiConfigFromEnv();
  const providers = pickProviders(
    { claude: claudeKey, qwen: qwen?.apiKey, openai: openai?.apiKey },
    Deno.env.get('INVOICE_PROVIDER_ORDER'),
  );

  const failures: string[] = [];
  for (const p of providers) {
    try {
      let reply: string;
      if (p === 'claude') {
        if (mime !== PDF_MIME && !IMAGE_MIMES.has(mime)) throw new Error(`Claude can't read ${mime}`);
        reply = await claudeExtract(claudeKey!, body.file_base64, mime);
      } else {
        if (!text) throw new Error(`${PROVIDER_LABELS[p]} needs PDF text (photo or scanned PDF)`);
        const cfg = (p === 'qwen' ? qwen : openai) as ProviderConfig;
        const prefix = p.toUpperCase();
        reply = await chatCompletion({
          label: PROVIDER_LABELS[p], apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
          keyEnvVar: `${prefix}_API_KEY`, baseUrlEnvVar: `${prefix}_BASE_URL`, modelEnvVar: `${prefix}_MODEL`,
          system: 'You read accounting documents. Output strict JSON only — no markdown, no commentary.',
          user: `Shipping invoice (text extracted from the PDF):\n<<<\n${text.slice(0, MAX_TEXT_CHARS)}\n>>>\n\n${PROMPT}`,
        });
      }
      const llm = parseFields(reply);
      // Model wins where it answered; regex fills its gaps.
      fields = Object.fromEntries(
        (Object.keys(EMPTY) as (keyof ShippingFields)[]).map(k => [k, llm[k] ?? fields[k]]),
      ) as ShippingFields;
      provider = p;
      break;
    } catch (e) {
      failures.push((e as Error)?.message ?? String(e));
    }
  }
  if (!provider) {
    extractError = providers.length === 0
      ? 'No LLM provider configured — only a text scan was run.'
      : chainFailures(failures);
  }

  return j({ fields, provider, extract_error: extractError });
});

async function claudeExtract(apiKey: string, b64: string, mime: string): Promise<string> {
  const block = mime === PDF_MIME
    ? { type: 'document', source: { type: 'base64', media_type: PDF_MIME, data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
}

function parseFields(reply: string): ShippingFields {
  const p = jsonFromModelText(reply);
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'null' ? v.trim()
      : typeof v === 'number' ? String(v) : null;
  const date = str(p.invoice_date);
  const order = str(p.order_number)?.replace(/\D/g, '') || null;
  return {
    carrier: str(p.carrier),
    invoice_number: str(p.invoice_number),
    invoice_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : normaliseDate(date),
    order_number: order,
    ship_to_city: str(p.ship_to_city),
    ship_to_postal: str(p.ship_to_postal),
  };
}

const CARRIER_PATTERNS: [RegExp, string][] = [
  // Case-sensitive: /ups/i would hit "pick-ups".
  [/\bUPS\b|United Parcel Service/, 'UPS'],
  [/Freightcom|ClickShip/i, 'Freightcom'],
  [/Goorooship/i, 'Goorooship'],
  [/FedEx|Federal Express/i, 'FedEx'],
  [/Canpar/i, 'Canpar'],
  [/Purolator/i, 'Purolator'],
  [/Canada Post|Postes Canada/i, 'Canada Post'],
  [/\bUSPS\b|United States Postal/i, 'USPS'],
];

/** Cheap deterministic pass over the PDF text + file name. Exported for tests. */
export function regexFields(text: string): Partial<ShippingFields> {
  const out: Partial<ShippingFields> = {};
  for (const [re, name] of CARRIER_PATTERNS) if (re.test(text)) { out.carrier = name; break; }
  const inv = text.match(/invoice\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i)
    ?? text.match(/\border[_\s-]*(?:number|no\.?|#)?\s*[:#]?\s*(\d{4,})/i);
  if (inv) out.invoice_number = inv[1];
  const dm = text.match(/invoice\s*date\s*[:]?\s*([A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (dm) out.invoice_date = normaliseDate(dm[1]);
  return out;
}

function normaliseDate(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s.replace(/\./g, ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
