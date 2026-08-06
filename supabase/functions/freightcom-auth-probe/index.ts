// freightcom-auth-probe — ops diagnostic, read-only.
//
// Answers two questions that otherwise require a support ticket to Freightcom:
//   1. Is FREIGHTCOM_API_KEY a LIVE key or a SANDBOX (ssd-test) key?
//   2. Does it carry finance/billing scope, or only shipping scope?
//
// It sends the same credential to both hosts and reports the raw status code
// per endpoint. Interpretation:
//   • 401/403 on a host        → the key does not belong to that environment
//   • 200/404 on /shipment/{id} → authenticated against that host (404 just
//                                 means that id isn't there — auth still passed)
//   • auth OK on /shipment but 401/403 on /finance/* → shipping scope only,
//     finance/billing scope missing from the key
//
// Every call here is a GET or a date-range POST that reads finance documents.
// Nothing books, quotes, cancels or mutates anything on the Freightcom side.
//
// Why this exists: sync-freightcom-shipments swallowed non-OK responses into an
// empty array for months, so an unauthenticated key looked exactly like an empty
// account and the Shipping dashboard sat 6 weeks stale without a single error.
// Run this whenever the Freightcom key is rotated or the dashboard goes quiet.
//
// POST body (optional): { shipment_id?: string }  — id used for the auth probe.

import { corsHeaders } from '../_shared/cors.ts';

const HOSTS: { label: string; url: string }[] = [
  { label: 'live',    url: 'https://external-api.freightcom.com' },
  { label: 'sandbox', url: 'https://customer-external-api.ssd-test.freightcom.com' },
];

type Result = {
  host: string;
  base_url: string;
  call: string;
  status: number | null;
  verdict: string;
  body_snippet: string;
};

function classify(call: string, status: number | null): string {
  if (status === null) return 'network error / unreachable';
  if (status === 401) return 'UNAUTHENTICATED — key not valid for this host';
  if (status === 403) return 'FORBIDDEN — host reached, credential rejected or wrong scope';
  if (status === 404) return call.includes('/shipment/')
    ? 'AUTH OK — id not found on this host (auth passed)'
    : 'endpoint not found on this host';
  if (status >= 200 && status < 300) return 'AUTH OK — call succeeded';
  if (status >= 500) return 'server error at Freightcom';
  return `unexpected ${status}`;
}

async function probe(
  host: { label: string; url: string }, apiKey: string, call: string,
  init: RequestInit, path: string,
): Promise<Result> {
  try {
    const res = await fetch(`${host.url}${path}`, init);
    const text = await res.text().catch(() => '');
    return {
      host: host.label, base_url: host.url, call,
      status: res.status, verdict: classify(call, res.status),
      body_snippet: text.slice(0, 200),
    };
  } catch (e) {
    return {
      host: host.label, base_url: host.url, call,
      status: null, verdict: classify(call, null),
      body_snippet: (e as Error)?.message?.slice(0, 200) ?? '',
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const apiKey = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrlEnv = Deno.env.get('FREIGHTCOM_BASE_URL');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'FREIGHTCOM_API_KEY not configured' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } });
  }

  let shipmentId = '45011657';
  try {
    const body = await req.json().catch(() => ({})) as { shipment_id?: string };
    if (body?.shipment_id) shipmentId = String(body.shipment_id);
  } catch { /* default */ }

  const to = new Date();
  const from = new Date(Date.now() - 730 * 86_400_000);
  const range = {
    from: { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() },
    to:   { year: to.getUTCFullYear(),   month: to.getUTCMonth() + 1,   day: to.getUTCDate() },
  };
  const qs = new URLSearchParams({
    from_year: String(range.from.year), from_month: String(range.from.month), from_day: String(range.from.day),
    to_year: String(range.to.year), to_month: String(range.to.month), to_day: String(range.to.day),
  });

  const results: Result[] = [];
  for (const host of HOSTS) {
    // Shipping scope — read a shipment. Read-only.
    results.push(await probe(host, apiKey, `GET /shipment/${shipmentId}`,
      { headers: { Authorization: apiKey } }, `/shipment/${shipmentId}`));
    // Finance scope — both shapes the sync tries.
    results.push(await probe(host, apiKey, 'POST /finance/documents',
      { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(range) }, '/finance/documents'));
    results.push(await probe(host, apiKey, 'GET /finance/documents',
      { headers: { Authorization: apiKey } }, `/finance/documents?${qs}`));
  }

  const authOk = (r: Result) => r.verdict.startsWith('AUTH OK');
  const summary = {
    key_length: apiKey.length,
    key_fingerprint: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
    FREIGHTCOM_BASE_URL_set: baseUrlEnv !== undefined,
    FREIGHTCOM_BASE_URL: baseUrlEnv ?? null,
    shipping_scope_ok_on: results.filter(r => r.call.startsWith('GET /shipment') && authOk(r)).map(r => r.host),
    finance_scope_ok_on:  results.filter(r => r.call.includes('/finance/')     && authOk(r)).map(r => r.host),
  };

  return new Response(JSON.stringify({ ok: true, summary, results }, null, 2),
    { headers: { ...corsHeaders, 'content-type': 'application/json' } });
});
