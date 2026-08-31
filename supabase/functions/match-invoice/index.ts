// match-invoice: parse a just-uploaded invoice PDF, figure out which order +
// customer it belongs to, and insert the customer_invoices row already linked.
//
// Flow (Upload module bulk flow):
//   1. Client uploads the PDF to the `customer-invoices` bucket.
//   2. Client POSTs { storage_path, file_name, document_type } here.
//   3. We download the PDF and hand it to an LLM (see Providers below) to
//      extract the fields that identify it — the Shopify order number is
//      printed in the line-item body (e.g. "Shopify order# 1192"), plus
//      invoice number / date / total / payment / bill-to name.
//   4. Match cascade: order number → orders row → its customer; else resolve
//      the bill-to name to a customer. Order match OR a customer-name match
//      (even with no order #, common for pre-Shopify / in-person / financing
//      invoices) → 'matched' and filed under the profile; only a complete miss
//      (no order AND no customer) → 'unassigned' for the review queue.
//   5. Insert the customer_invoices row with whatever we resolved and return it.
//
// Extraction/match failures are non-fatal: the row is still inserted (status
// 'unassigned') so a bulk upload never hard-fails and the operator can assign
// it from the Upload review queue. The reason is returned as `extract_error`
// and shown in the Upload results table — a silent fallback to "unassigned"
// is what let a dead extractor go unnoticed for two weeks.
//
// Providers: Claude, then Qwen, then OpenAI — whichever have keys configured,
// in that order (override with INVOICE_PROVIDER_ORDER). Any HTTP or network
// error from one falls through to the next. The Anthropic account running out
// of credit on 2026-08-13 is exactly why: every invoice uploaded after it
// extracted nothing — no order #, no amounts — and dropped into the review
// queue for manual assignment. parse-resume-batch was given this chain on
// 2026-08-26; this is the same fix for the same outage.
// Setup + troubleshooting: docs/llm-document-providers.md

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
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

type MatchInput = {
  storage_path: string;
  file_name: string;
  document_type?: 'invoice' | 'refund_receipt';
};

// Re-run extraction over invoices already on file, to pick up fields the
// original parse never captured (payment_cad). Batched — the caller loops
// until `remaining` hits 0 — so one invocation never runs past its timeout.
type ReextractInput = { reextract: true; limit?: number };

type Extracted = {
  invoice_number: string | null;
  invoice_date: string | null;   // ISO YYYY-MM-DD
  total_cad: number | null;
  payment_cad: number | null;
  shopify_order_number: string | null;
  bill_to_name: string | null;
};

/** The providers this invocation can actually use, resolved from secrets. */
type ProviderChain = {
  providers: LlmProvider[];
  claudeKey?: string;
  qwen: ProviderConfig | null;
  openai: ProviderConfig | null;
};

function providerChain(): ProviderChain {
  const claudeKey = Deno.env.get('ANTHROPIC_API_KEY') || undefined;
  const qwen = qwenConfigFromEnv();
  const openai = openaiConfigFromEnv();
  return {
    claudeKey, qwen, openai,
    providers: pickProviders(
      { claude: claudeKey, qwen: qwen?.apiKey, openai: openai?.apiKey },
      Deno.env.get('INVOICE_PROVIDER_ORDER'),
    ),
  };
}

const NO_PROVIDER =
  'No LLM provider configured — set ANTHROPIC_API_KEY, QWEN_API_KEY or OPENAI_API_KEY via supabase secrets set.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return j({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const body = (await req.json()) as MatchInput | ReextractInput;
  if ((body as ReextractInput).reextract) {
    return await reextractBatch(admin, (body as ReextractInput).limit ?? 20);
  }
  const { storage_path, file_name, document_type } = body as MatchInput;
  const documentType = document_type === 'refund_receipt' ? 'refund_receipt' : 'invoice';
  if (!storage_path || !file_name) return j({ error: 'storage_path and file_name required' }, 400);

  // ── Download the uploaded PDF ──────────────────────────────────────────
  const { data: blob, error: dlErr } = await admin.storage.from('customer-invoices').download(storage_path);
  if (dlErr || !blob) return j({ error: `Could not read uploaded file: ${dlErr?.message}` }, 404);
  const pdfBytes = await blob.arrayBuffer();

  // ── Extract fields (non-fatal) ─────────────────────────────────────────
  // Filename gives a guaranteed-ish number fallback
  // ("Invoice_1356_from_VCycene_Inc.pdf" → 1356) even when no provider can
  // read the PDF at all.
  let extracted: Extracted = {
    invoice_number: invoiceNumberFromFilename(file_name),
    invoice_date: null,
    total_cad: null,
    payment_cad: null,
    shopify_order_number: null,
    bill_to_name: null,
  };
  let extractError: string | null = null;
  let extractProvider: LlmProvider | null = null;
  const chain = providerChain();
  if (chain.providers.length === 0) {
    extractError = `${NO_PROVIDER} Only the filename was parsed.`;
  } else {
    try {
      const read = await extractInvoiceFields(chain, pdfBytes);
      extractProvider = read.provider;
      extracted = {
        invoice_number: read.fields.invoice_number ?? extracted.invoice_number,
        invoice_date: read.fields.invoice_date,
        total_cad: read.fields.total_cad,
        payment_cad: read.fields.payment_cad,
        shopify_order_number: read.fields.shopify_order_number,
        bill_to_name: read.fields.bill_to_name,
      };
    } catch (e) {
      extractError = (e as Error).message;
    }
  }

  // ── Match cascade ──────────────────────────────────────────────────────
  let customerId: string | null = null;
  let orderId: string | null = null;
  let orderRef: string | null = null;
  let matchMethod: string | null = null;
  let matchStatus: 'matched' | 'needs_review' | 'unassigned' = 'unassigned';

  const orderDigits = digitsOnly(extracted.shopify_order_number);
  if (orderDigits) {
    const { data: ord } = await admin
      .from('orders')
      .select('id, order_ref, customer_id, customer_email, customer_name')
      .or(`order_ref.eq.#${orderDigits},order_ref.eq.${orderDigits}`)
      .limit(1)
      .maybeSingle();
    if (ord) {
      orderId = ord.id;
      orderRef = ord.order_ref;
      matchMethod = 'order_number';
      matchStatus = 'matched';
      customerId = ord.customer_id ?? null;
      if (!customerId && (ord.customer_email || ord.customer_name)) {
        const { data: rid } = await admin.rpc('resolve_customer_id', {
          p_email: ord.customer_email ?? null,
          p_name:  ord.customer_name ?? null,
        });
        customerId = (rid as string | null) ?? null;
      }
    } else {
      // We read an order number off the invoice but it doesn't match any order
      // we have — keep it visible for the operator rather than dropping it.
      orderRef = `#${orderDigits}`;
    }
  }

  // Fallback: no confident order match — try resolving the bill-to name to a
  // customer so the invoice at least lands on the right profile for review.
  if (!customerId && extracted.bill_to_name) {
    const { data: rid } = await admin.rpc('resolve_customer_id', {
      p_email: null,
      p_name:  extracted.bill_to_name,
    });
    if (rid) {
      customerId = rid as string;
      matchMethod = matchMethod ?? 'name';
    }
  }

  // Status: a resolved order is a confident match. A customer-name resolution
  // (even with NO order #) is also enough to file the invoice under that
  // profile — many pre-Shopify / in-person sales and Sharpei-financing invoices
  // have no order number at all, but the bill-to name matches an existing
  // customer. Only a complete miss (no order AND no customer) stays in review.
  if (matchStatus !== 'matched') {
    matchStatus = customerId ? 'matched' : 'unassigned';
  }

  // ── Insert the row ─────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('customer_invoices')
    .insert({
      customer_id:    customerId,
      order_id:       orderId,
      order_ref:      orderRef,
      invoice_number: extracted.invoice_number ?? '(unknown)',
      document_type:  documentType,
      file_name,
      storage_path,
      invoice_date:   extracted.invoice_date,
      total_cad:      extracted.total_cad,
      payment_cad:    extracted.payment_cad,
      // Only count the PDF as read for a payment when the LLM actually ran, so
      // a filename-only fallback still gets picked up by the backfill.
      payment_extracted_at: extractError ? null : new Date().toISOString(),
      bill_to_name:   extracted.bill_to_name,
      match_status:   matchStatus,
      match_method:   matchMethod,
      uploaded_by:    caller.email,
    })
    .select('*')
    .single();
  if (insErr) return j({ error: `DB insert failed: ${insErr.message}` }, 500);

  return j({
    invoice: inserted,
    extract_error: extractError,
    provider: extractProvider,
    providers_tried: chain.providers,
  });
});

// ────────────────────────────────────────────────────────────────────────

/** Re-read amounts off invoices already on file. Only rows never read for a
 *  payment are touched, so this is resumable and idempotent: the caller keeps
 *  calling until a pass stops making progress.
 *
 *  Deliberately narrow — it writes ONLY the extracted amounts (and a date/number
 *  that was missing). Customer/order linkage and match_status are operator-
 *  curated (system-of-record rule) and are never overwritten here, even when
 *  this parse would resolve them differently. */
async function reextractBatch(
  admin: SupabaseClient,
  limit: number,
): Promise<Response> {
  const chain = providerChain();
  if (chain.providers.length === 0) return j({ error: NO_PROVIDER }, 500);

  // Keyed on "never read for a payment", NOT on "payment_cad is null" — an
  // invoice with no Payment line legitimately stays null, and would otherwise
  // be handed back on every pass while later invoices were never reached.
  const { count: remainingBefore } = await admin
    .from('customer_invoices')
    .select('id', { count: 'exact', head: true })
    .is('payment_extracted_at', null);

  const { data: rows, error } = await admin
    .from('customer_invoices')
    .select('id, storage_path, file_name, invoice_number, invoice_date, total_cad')
    .is('payment_extracted_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) return j({ error: `Could not list invoices: ${error.message}` }, 500);

  const errors: { file_name: string; error: string }[] = [];
  const providersUsed = new Set<LlmProvider>();
  const down = new Map<LlmProvider, string>();
  let updated = 0;

  for (const row of rows ?? []) {
    try {
      const { data: blob, error: dlErr } = await admin.storage
        .from('customer-invoices').download(row.storage_path as string);
      if (dlErr || !blob) throw new Error(dlErr?.message ?? 'file missing from bucket');
      const read = await extractInvoiceFields(chain, await blob.arrayBuffer(), down);
      const llm = read.fields;
      providersUsed.add(read.provider);

      // payment_cad is what we came for; the rest only fills genuine gaps.
      const patch: Record<string, unknown> = {
        payment_cad: llm.payment_cad,
        payment_extracted_at: new Date().toISOString(),
      };
      if (llm.total_cad != null) patch.total_cad = llm.total_cad;
      if (llm.invoice_date && !row.invoice_date) patch.invoice_date = llm.invoice_date;
      if (llm.invoice_number && row.invoice_number === '(unknown)') patch.invoice_number = llm.invoice_number;

      const { error: upErr } = await admin
        .from('customer_invoices').update(patch).eq('id', row.id as string);
      if (upErr) throw new Error(upErr.message);
      updated++;
    } catch (e) {
      // A PDF that won't parse must not stall the batch — but it also must not
      // be silently skipped forever, so it is named in the response.
      errors.push({ file_name: row.file_name as string, error: (e as Error).message });
    }
  }

  const processed = (rows ?? []).length;
  return j({
    processed,
    updated,
    // Rows that errored stay unread, so they come back on the next pass; the
    // caller stops on updated === 0 rather than waiting for this to reach 0.
    remaining: Math.max((remainingBefore ?? processed) - updated, 0),
    stalled: errors.length,
    errors,
    providers: [...providersUsed],
    providers_tried: chain.providers,
  });
}

/** The fields that identify an invoice, in a prompt every provider gets
 *  verbatim. Kept as one constant so the document-mode (Claude) and text-mode
 *  (Qwen/OpenAI) paths can never drift apart on what they ask for. */
const EXTRACT_PROMPT =
`You are reading a sales invoice PDF (QuickBooks style). Reply with ONLY a JSON object, no prose, with these fields:
- "invoice_number": the invoice number as a string (e.g. "1356"), or null. On a refund receipt this is the receipt's reference number.
- "invoice_date": the invoice DATE in ISO format YYYY-MM-DD. The PDF may show it as DD/MM/YYYY. Null if absent.
- "total_cad": the invoice TOTAL in CAD — the "Total" line, the full value of the invoice. NOT "Total Due" / "Balance Due", which read $0.00 on an invoice whose payment has already been applied. Number only, no currency symbol, no thousands separators. Null if absent.
- "payment_cad": the amount on the "Payment" line — what the customer actually paid, in CAD. This is the figure a refund is based on. Same number formatting. Null if the invoice shows no payment.
- "shopify_order_number": the Shopify order number if it appears anywhere (often in the line-item description, e.g. "Shopify order# 1192" → "1192"). Digits only. Null if absent.
- "bill_to_name": the customer name in the BILL TO section, or null.`;

/** Read the invoice with the first provider that answers.
 *
 *  Any HTTP or network error falls through to the next provider — that is the
 *  whole point of the chain, since the trigger was a 400 "credit balance is
 *  too low" that made every upload extract nothing. A provider that DOES
 *  answer but returns unparseable JSON is not retried elsewhere: that's a
 *  model-output problem, not an availability one, and the same rule the
 *  hiring path follows.
 *
 *  `down` is a per-batch memo: a provider that has already failed on an
 *  earlier file is skipped for the rest of the run. With Claude out of credit
 *  and 100+ invoices to backfill, retrying it per row would spend the whole
 *  invocation on round-trips that are known to fail and time the batch out.
 *  Scoped to one invocation, so the next call re-tries everything.
 *
 *  Throws with every failure chained when no provider got through. */
async function extractInvoiceFields(
  chain: ProviderChain, pdfBytes: ArrayBuffer, down?: Map<LlmProvider, string>,
): Promise<{ fields: Extracted; provider: LlmProvider }> {
  const failures: string[] = [];
  for (const provider of chain.providers) {
    const alreadyDown = down?.get(provider);
    if (alreadyDown) { failures.push(alreadyDown); continue; }
    let reply: string;
    try {
      reply = provider === 'claude'
        ? await claudeExtract(chain.claudeKey!, pdfBytes)
        : await textProviderExtract(provider, provider === 'qwen' ? chain.qwen! : chain.openai!, pdfBytes);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      failures.push(msg);
      down?.set(provider, msg);
      continue;
    }
    // Answering clears an earlier strike: a one-off 429 shouldn't sideline a
    // provider that is plainly working now.
    down?.delete(provider);
    return { fields: parseExtracted(reply, PROVIDER_LABELS[provider]), provider };
  }
  throw new Error(chainFailures(failures));
}

/** Primary provider: the PDF goes to Claude as a base64 document block.
 *  Returns the raw text of the reply, or throws Error("Claude <status>: …")
 *  so the caller can fall through to the next provider. */
async function claudeExtract(apiKey: string, pdfBytes: ArrayBuffer): Promise<string> {
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: PDF_MIME, data: base64FromArrayBuffer(pdfBytes) } },
            { type: 'text', text: EXTRACT_PROMPT },
          ],
        }],
      }),
    });
  } catch (e) {
    throw new Error(`Claude request failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
}

/** Longest invoice text we'll send to a text-mode provider. A QuickBooks
 *  invoice is a page or two; anything past this is a mis-uploaded file, and
 *  the cap keeps one of those from blowing the model's context. */
const MAX_INVOICE_TEXT_CHARS = 40_000;

/** Fallback providers: neither chat API takes a document, so the PDF text is
 *  extracted locally and sent inline ahead of the same prompt. A scanned
 *  (image-only) PDF yields no text and is reported as such rather than sent
 *  empty — a blank body would come back as a confident all-nulls answer, which
 *  is worse than a named failure. */
async function textProviderExtract(
  provider: Exclude<LlmProvider, 'claude'>, cfg: ProviderConfig, pdfBytes: ArrayBuffer,
): Promise<string> {
  const label = PROVIDER_LABELS[provider];
  const prefix = provider.toUpperCase();
  let text: string;
  try { text = await extractDocumentText(pdfBytes, PDF_MIME); }
  catch (e) { throw new Error(`${label} could not read the PDF: ${(e as Error)?.message ?? String(e)}`); }
  if (!text) throw new Error(`${label} found no text in this PDF (scanned/image-only?)`);
  const body = text.length > MAX_INVOICE_TEXT_CHARS
    ? `${text.slice(0, MAX_INVOICE_TEXT_CHARS)}\n[… truncated …]`
    : text;
  return chatCompletion({
    label, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model,
    keyEnvVar: `${prefix}_API_KEY`, baseUrlEnvVar: `${prefix}_BASE_URL`, modelEnvVar: `${prefix}_MODEL`,
    system: 'You read accounting documents. Output strict JSON only — no markdown, no commentary.',
    user: `Invoice (plain text extracted from the PDF):\n<<<\n${body}\n>>>\n\n${EXTRACT_PROMPT}`,
  });
}

/** Coerces a model reply into Extracted. Strings that aren't numbers, and
 *  empty strings, become null rather than NaN or "" — a bad parse must read as
 *  "not found" so the review queue catches it, never as a value. */
export function parseExtracted(reply: string, label = 'Model'): Extracted {
  let p: Record<string, unknown>;
  try { p = jsonFromModelText(reply); }
  catch (e) { throw new Error(`${label}: ${(e as Error)?.message ?? String(e)}`); }
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v.replace(/[$,\s]/g, ''))) ? Number(v.replace(/[$,\s]/g, '')) : null);
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  return {
    invoice_number: str(p.invoice_number),
    invoice_date: str(p.invoice_date),
    total_cad: num(p.total_cad),
    payment_cad: num(p.payment_cad),
    shopify_order_number: str(p.shopify_order_number),
    bill_to_name: str(p.bill_to_name),
  };
}

/** Last-resort number when no provider could read the PDF. QuickBooks names
 *  both document kinds predictably — "Invoice_1356_from_VCycene_Inc.pdf" and
 *  "Refund_Receipt_Ref_0042_from_VCycene_Inc.pdf" — and a refund receipt that
 *  came back as "(unknown)" is unidentifiable in the review queue, which is
 *  half of what this tab uploads. Exported for tests. */
export function invoiceNumberFromFilename(fileName: string): string | null {
  const m = fileName.match(/(?:invoice|receipt[_\s-]*ref|ref)[_\s-]*#?\s*(\d{2,})/i);
  return m ? m[1] : null;
}

function digitsOnly(s: string | null): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length >= 2 ? d : null;
}

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
