// freightcom-endpoint-scan — ops diagnostic, read-only.
//
// Answers "what can this key actually reach?" by GETting a list of candidate
// routes and reporting the status of each. Written 2026-08-11, when the live key
// finally authenticated and immediately raised a harder question:
//
//   GET /finance/documents  → 200, 774 documents keyed by a `number` like
//                             "43694778" (the portal's transaction number)
//   GET /shipment/43694778  → 404 not found
//   GET /shipment/<doc id>  → 404 not found
//
// So the finance API and the shipment API do not share an id space, and the
// transaction numbers we store in shipments.freightcom_shipment_id resolve in
// the former but not the latter. Before designing around that, establish by
// measurement which routes exist — in particular whether ANY route lists
// shipments, since without one the dashboard can never mirror the portal.
//
// Nothing here books, quotes, cancels or mutates. Every call is a GET.
//
// POST body (optional):
//   { number?: string }  — a transaction number to interpolate into routes
//   { doc_id?: string }  — a finance-document id to interpolate into routes
//   { paths?: string[] } — scan these instead of the built-in candidate list

import { corsHeaders } from '../_shared/cors.ts';

const LIVE = 'https://external-api.freightcom.com';

function candidates(num: string, docId: string, from: string, to: string): string[] {
  const range = `start_date=${from}&end_date=${to}`;
  return [
    // Does anything list shipments? This is the question that matters most.
    `/shipments?${range}`,
    `/shipment?${range}`,
    '/shipments',
    '/shipment',
    `/shipments/search?${range}`,
    `/shipment/search?${range}`,
    // Finance — known good, plus per-shipment and per-document detail.
    `/finance/documents?${range}`,
    `/finance/documents/${docId}`,
    `/finance/invoices-for-shipment-id/${num}`,
    `/finance/invoices-for-shipment-id/${docId}`,
    '/finance/payment-methods',
    // Shipment detail under each id we hold, plus tracking.
    `/shipment/${num}`,
    `/shipment/${num}/tracking-events`,
    `/track/${num}`,
    `/tracking/${num}`,
  ];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const apiKey = Deno.env.get('FREIGHTCOM_API_KEY')?.trim();
  // .trim() is deliberate: a secret pasted through a dashboard textarea arrives
  // with trailing newlines, which silently poison string comparisons and URLs.
  const baseUrl = (Deno.env.get('FREIGHTCOM_BASE_URL')?.trim()) || LIVE;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'FREIGHTCOM_API_KEY not configured' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as
    { number?: string; doc_id?: string; paths?: string[]; full?: boolean };
  const num   = body.number ?? '43694778';
  const docId = body.doc_id ?? '028uK6URd6MJa7YXqpP8hjm2Y29HFFW7';

  const to = new Date();
  const from = new Date(Date.now() - 730 * 86_400_000);
  const asDate = (d: Date) => d.toISOString().slice(0, 10);

  const paths = body.paths ?? candidates(num, docId, asDate(from), asDate(to));

  const results = [];
  for (const path of paths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: apiKey } });
      const text = await res.text().catch(() => '');
      results.push({
        path,
        status: res.status,
        // Length matters as much as the snippet: a 200 returning "[]" is a route
        // that exists but has nothing for us, which reads very differently from
        // a 200 carrying a payload.
        bytes: text.length,
        // `full` returns the untruncated body so a payload can be analysed
        // offline — shape, cardinality, id overlap with what we already store.
        body_snippet: body.full ? text : text.slice(0, 300),
      });
    } catch (e) {
      results.push({ path, status: null, bytes: 0,
                     body_snippet: (e as Error)?.message?.slice(0, 200) ?? 'network error' });
    }
  }

  const reachable = results.filter((r) => r.status && r.status >= 200 && r.status < 300)
                           .map((r) => r.path);

  return new Response(JSON.stringify({ ok: true, base_url: baseUrl, reachable, results }, null, 2),
    { headers: { ...corsHeaders, 'content-type': 'application/json' } });
});
