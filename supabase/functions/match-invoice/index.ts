// match-invoice: parse a just-uploaded invoice PDF, figure out which order +
// customer it belongs to, and insert the customer_invoices row already linked.
//
// Flow (Upload module bulk flow):
//   1. Client uploads the PDF to the `customer-invoices` bucket.
//   2. Client POSTs { storage_path, file_name, document_type } here.
//   3. We download the PDF, hand it to Claude to extract the fields that
//      identify it — the Shopify order number is printed in the line-item body
//      (e.g. "Shopify order# 1192"), plus invoice number / date / total /
//      bill-to name.
//   4. Match cascade: order number → orders row → its customer; else resolve
//      the bill-to name to a customer. Confident order match → 'matched';
//      customer-only (no order) → 'needs_review'; nothing → 'unassigned'.
//   5. Insert the customer_invoices row with whatever we resolved and return it.
//
// Extraction/match failures are non-fatal: the row is still inserted (status
// 'unassigned') so a bulk upload never hard-fails and the operator can assign
// it from the Upload review queue.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

type MatchInput = {
  storage_path: string;
  file_name: string;
  document_type?: 'invoice' | 'refund_receipt';
};

type Extracted = {
  invoice_number: string | null;
  invoice_date: string | null;   // ISO YYYY-MM-DD
  total_cad: number | null;
  shopify_order_number: string | null;
  bill_to_name: string | null;
};

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

  const body = (await req.json()) as MatchInput;
  const { storage_path, file_name } = body;
  const documentType = body.document_type === 'refund_receipt' ? 'refund_receipt' : 'invoice';
  if (!storage_path || !file_name) return j({ error: 'storage_path and file_name required' }, 400);

  // ── Download the uploaded PDF ──────────────────────────────────────────
  const { data: blob, error: dlErr } = await admin.storage.from('customer-invoices').download(storage_path);
  if (dlErr || !blob) return j({ error: `Could not read uploaded file: ${dlErr?.message}` }, 404);
  const pdfBase64 = base64FromArrayBuffer(await blob.arrayBuffer());

  // ── Extract fields (non-fatal) ─────────────────────────────────────────
  // Filename gives a guaranteed-ish invoice-number fallback
  // ("Invoice_1356_from_VCycene_Inc.pdf" → 1356) even if Claude is unavailable.
  let extracted: Extracted = {
    invoice_number: invoiceNumberFromFilename(file_name),
    invoice_date: null,
    total_cad: null,
    shopify_order_number: null,
    bill_to_name: null,
  };
  let extractError: string | null = null;
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    try {
      const llm = await claudeExtract(anthropicKey, pdfBase64);
      extracted = {
        invoice_number: llm.invoice_number ?? extracted.invoice_number,
        invoice_date: llm.invoice_date,
        total_cad: llm.total_cad,
        shopify_order_number: llm.shopify_order_number,
        bill_to_name: llm.bill_to_name,
      };
    } catch (e) {
      extractError = (e as Error).message;
    }
  } else {
    extractError = 'ANTHROPIC_API_KEY not configured — only filename was parsed.';
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

  // Status: a resolved order is a confident match. A customer-only resolution
  // (no order) or anything weaker needs an operator to confirm.
  if (matchStatus !== 'matched') {
    matchStatus = customerId ? 'needs_review' : 'unassigned';
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
      bill_to_name:   extracted.bill_to_name,
      match_status:   matchStatus,
      match_method:   matchMethod,
      uploaded_by:    caller.email,
    })
    .select('*')
    .single();
  if (insErr) return j({ error: `DB insert failed: ${insErr.message}` }, 500);

  return j({ invoice: inserted, extract_error: extractError });
});

// ────────────────────────────────────────────────────────────────────────

async function claudeExtract(apiKey: string, pdfBase64: string): Promise<Extracted> {
  const prompt =
`You are reading a sales invoice PDF (QuickBooks style). Reply with ONLY a JSON object, no prose, with these fields:
- "invoice_number": the invoice number as a string (e.g. "1356"), or null.
- "invoice_date": the invoice DATE in ISO format YYYY-MM-DD. The PDF may show it as DD/MM/YYYY. Null if absent.
- "total_cad": the total amount due in CAD as a number (no currency symbol, no thousands separators), or null.
- "shopify_order_number": the Shopify order number if it appears anywhere (often in the line-item description, e.g. "Shopify order# 1192" → "1192"). Digits only. Null if absent.
- "bill_to_name": the customer name in the BILL TO section, or null.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  const p = JSON.parse(m[0]) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : null);
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  return {
    invoice_number: str(p.invoice_number),
    invoice_date: str(p.invoice_date),
    total_cad: num(p.total_cad),
    shopify_order_number: str(p.shopify_order_number),
    bill_to_name: str(p.bill_to_name),
  };
}

function invoiceNumberFromFilename(fileName: string): string | null {
  const m = fileName.match(/invoice[_\s-]*#?\s*(\d{2,})/i);
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
