// sync-freightcom-shipments
//
// Keeps public.shipments — the Shipping dashboard's table — current against the
// Freightcom API: costs, statuses, tracking numbers and delivery dates.
//
// ⚠ HISTORY (2026-08-06): this function existed only as an ad-hoc deployment
// (entrypoint /tmp/user_fn_…) with no copy in the repo. It has never written a
// row. Three faults were fixed on 2026-08-06 (cron timeout, finance-call
// parameters, swallowed errors); this revision fixes the two that remained.
//
// ── Discovery ──────────────────────────────────────────────────────────────
// Discovery used to be invoice-only: list finance documents, pull shipment ids
// out of them, fetch those. That has a hole big enough to explain the empty Rate
// column on its own — a shipment is invisible until Freightcom raises a finance
// document for it, which is up to a billing cycle after it ships, and a shipment
// that was already in our table but never appeared on a fetched invoice was
// never revisited. All 38 rows on the dashboard are in exactly that position:
// real Freightcom transaction numbers, hand-loaded from a tracking-dashboard
// export, never once looked up against the API.
//
// Discovery is now the UNION of:
//   1. every freightcom_shipment_id already in public.shipments  ← reconciliation
//   2. shipment ids named by GET /finance/documents              ← new shipments
//
// so an existing row gets its cost filled in on the next run, and a new shipment
// still gets picked up when its invoice lands.
//
// ── Writes ─────────────────────────────────────────────────────────────────
// Per the repo's system-of-record rule, this sync adds what the API knows and
// leaves everything else alone: null fields are pruned before the upsert rather
// than overwriting stored values, and raw_payload is merged so the hand-loaded
// provenance keys the dashboard derives Customer and Direction from survive.
//
// Body (all optional):
//   { probe?: boolean }   — report the finance/auth state, write nothing
//   { limit?: number }    — cap shipments processed this run
//
// Env vars:
//   FREIGHTCOM_API_KEY   — bare token (no Bearer prefix)
//   FREIGHTCOM_BASE_URL  — host to talk to. Defaults to the ssd-test SANDBOX,
//     matching freightcom-book / -invoices / -quote / -status / -tracking. Set
//     it to https://external-api.freightcom.com together with a LIVE key to
//     point the integration at the real account.
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  type FCDoc, money, splitCurrency, cadOnly, breakdown,
  pruneNulls, mergeRawPayload, mapStatus,
} from './parse.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Matches the other five freightcom-* functions. Previously this one alone
// defaulted to the live host, so the integration straddled two environments.
const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';
const LIVE_BASE_URL    = 'https://external-api.freightcom.com';

const DAYS_BACK   = 730; // 2 years of finance documents
const MAX_SHIPMENTS = 500;
const CONCURRENCY = 4;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a Freightcom call actually did — surfaced so a zero-result run can be
 *  diagnosed without redeploying. */
type Probe = { call: string; status: number | null; ok: boolean; body_snippet: string };

function envelope(data: unknown): FCDoc[] | null {
  if (Array.isArray(data)) return data as FCDoc[];
  for (const key of ['documents', 'invoices', 'items', 'data', 'results']) {
    const v = (data as FCDoc)?.[key];
    if (Array.isArray(v)) return v as FCDoc[];
  }
  return null;
}

// Freightcom's finance document list.
//
// Verified against the API on 2026-08-06 (freightcom-auth-probe):
//   GET /finance/documents?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD  → 200
//   …&start_date only                     → 400 {"end_date":"missing"}
//   …ISO-8601 datetimes instead of dates   → 400 {"start_date":"missing"}
//   POST /finance/documents                → 403 (AWS SigV4 complaint — the
//                                            route has no POST method; GET-only)
// Both parameters are required and both must be plain dates.
async function fetchFinanceDocs(
  baseUrl: string, apiKey: string, probes: Probe[],
): Promise<{ docs: FCDoc[]; authOk: boolean }> {
  const end   = new Date();
  const start = new Date(Date.now() - DAYS_BACK * 86_400_000);
  const asDate = (d: Date) => d.toISOString().slice(0, 10);

  const params = new URLSearchParams({ start_date: asDate(start), end_date: asDate(end) });
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/finance/documents?${params}`, {
      headers: { Authorization: apiKey },
    });
  } catch (e) {
    probes.push({ call: 'GET /finance/documents', status: null, ok: false,
                  body_snippet: (e as Error)?.message?.slice(0, 300) ?? 'network error' });
    return { docs: [], authOk: false };
  }
  const text = await res.text();
  probes.push({
    call: `GET /finance/documents?start_date=${asDate(start)}&end_date=${asDate(end)}`,
    status: res.status, ok: res.ok, body_snippet: text.slice(0, 300),
  });
  if (!res.ok) return { docs: [], authOk: res.status !== 401 && res.status !== 403 };
  try {
    return { docs: envelope(JSON.parse(text)) ?? [], authOk: true };
  } catch { return { docs: [], authOk: true }; }
}

function extractShipmentIds(docs: FCDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const doc of docs) {
    for (const field of ['shipment_id', 'shipmentId', 'freight_shipment_id']) {
      const v = doc[field];
      if (typeof v === 'string' && v) ids.add(v);
      if (typeof v === 'number') ids.add(String(v));
    }
    const lines = (doc['line_items'] ?? doc['lineItems'] ?? doc['items'] ?? doc['shipments']) as FCDoc[] | undefined;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        for (const field of ['shipment_id', 'shipmentId', 'id']) {
          const sid = line[field];
          if (sid) ids.add(String(sid));
        }
      }
    }
  }
  return ids;
}

async function fetchShipment(
  baseUrl: string, apiKey: string, id: string,
): Promise<{ doc: FCDoc | null; status: number | null }> {
  const url = `${baseUrl}/shipment/${encodeURIComponent(id)}`;
  const get = () => fetch(url, { headers: { Authorization: apiKey } });
  let res = await get();
  if (res.status === 202) { await delay(2000); res = await get(); } // still assembling
  if (!res.ok) return { doc: null, status: res.status };
  try { return { doc: (await res.json()) as FCDoc, status: res.status }; }
  catch { return { doc: null, status: res.status }; }
}

async function fetchShipmentInvoices(baseUrl: string, apiKey: string, id: string): Promise<FCDoc[]> {
  const res = await fetch(
    `${baseUrl}/finance/invoices-for-shipment-id/${encodeURIComponent(id)}`,
    { headers: { Authorization: apiKey } },
  );
  if (!res.ok) return [];
  try {
    const data = await res.json();
    return envelope(data) ?? [];
  } catch { return []; }
}

function str(obj: FCDoc | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && v !== '') return String(v);
  }
  return null;
}

/** Plain numeric reader, for the measurements that are NOT money — weight and
 *  cuboid dimensions come back as bare units, never as cents. */
function num(obj: FCDoc | null, ...keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    const parsed = parseFloat(String(v));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function nested(obj: FCDoc | null, ...path: string[]): FCDoc | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as FCDoc)[k];
  }
  return (cur as FCDoc) ?? null;
}

/** Freightcom dates arrive either as {year,month,day} or as an ISO string. */
function toDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (typeof v === 'object') {
    const { year, month, day } = v as { year?: number; month?: number; day?: number };
    if (year && month && day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

const toIso = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : null);

/** Runs `fn` over `items` with a bounded number in flight. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({})) as { probe?: boolean; limit?: number };
  try { return await handle(body?.probe === true, body?.limit); }
  catch (err) {
    return json({ ok: false, error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(probeOnly: boolean, limit?: number): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey      = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrlEnv  = Deno.env.get('FREIGHTCOM_BASE_URL');
  const baseUrl     = baseUrlEnv ?? DEFAULT_BASE_URL;

  if (!apiKey) return json({ ok: false, error: 'FREIGHTCOM_API_KEY not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Reconciliation set — everything already on the dashboard.
  const { data: existingRows, error: existingErr } = await admin
    .from('shipments')
    .select('freightcom_shipment_id, raw_payload')
    .not('freightcom_shipment_id', 'is', null);
  if (existingErr) return json({ ok: false, error: `Reading shipments: ${existingErr.message}` }, 500);

  const stored = new Map<string, FCDoc | null>(
    (existingRows ?? []).map((r) => [
      String((r as { freightcom_shipment_id: string }).freightcom_shipment_id),
      (r as { raw_payload: FCDoc | null }).raw_payload,
    ]),
  );

  // 2. Discovery set — shipments named by finance documents.
  const probes: Probe[] = [];
  const { docs, authOk } = await fetchFinanceDocs(baseUrl, apiKey, probes);
  const invoiceIds = extractShipmentIds(docs);

  const warnings: string[] = [];
  if (!authOk) {
    warnings.push(
      `Freightcom rejected the credential on ${baseUrl}. No costs can be synced until ` +
      `FREIGHTCOM_API_KEY and FREIGHTCOM_BASE_URL name the same environment.`,
    );
  }
  if (baseUrlEnv === undefined) {
    warnings.push(
      `FREIGHTCOM_BASE_URL is unset — defaulting to the ssd-test sandbox. The live ` +
      `account is at ${LIVE_BASE_URL}; set the var explicitly so the environment is ` +
      `not implied.`,
    );
  }

  const diagnostics = {
    base_url: baseUrl,
    base_url_from_env: baseUrlEnv !== undefined,
    environment: baseUrl === LIVE_BASE_URL ? 'live' : 'sandbox',
    api_key_len: apiKey.length,
    existing_rows: stored.size,
    invoice_ids: invoiceIds.size,
    probes,
  };

  if (probeOnly) {
    return json({ ok: authOk, probe: true, invoices_fetched: docs.length,
                  shipment_ids_found: invoiceIds.size, warnings, diagnostics });
  }

  // A credential the API refuses can only produce a run that looks like "nothing
  // to do". Stop here rather than reporting a healthy zero.
  if (!authOk) {
    return json({ ok: false, error: 'Freightcom authentication failed', warnings, diagnostics }, 502);
  }

  // Invoice metadata keyed by shipment, used when the per-shipment invoice call
  // returns nothing but the document list already named a total.
  const invoiceByShipment = new Map<string, FCDoc>();
  for (const doc of docs) {
    const sid = str(doc, 'shipment_id', 'shipmentId', 'freight_shipment_id');
    if (sid) invoiceByShipment.set(sid, doc);
    const lines = (doc['line_items'] ?? doc['lineItems'] ?? doc['items'] ?? doc['shipments'] ?? []) as FCDoc[];
    for (const line of Array.isArray(lines) ? lines : []) {
      const lsid = str(line, 'shipment_id', 'shipmentId', 'id');
      if (lsid) invoiceByShipment.set(lsid, doc);
    }
  }

  const allIds = [...new Set([...stored.keys(), ...invoiceIds])];
  const cap = Math.max(0, Math.min(limit ?? MAX_SHIPMENTS, MAX_SHIPMENTS));
  const targets = allIds.slice(0, cap);
  if (allIds.length > targets.length) {
    warnings.push(`${allIds.length - targets.length} shipment(s) not processed this run (cap ${cap}).`);
  }

  let upserted = 0, costed = 0, notFound = 0, errors = 0;

  const results = await mapPool(targets, CONCURRENCY, async (shipmentId) => {
    try {
      const { doc: s, status } = await fetchShipment(baseUrl, apiKey, shipmentId);
      if (!s) return status === 404 ? 'not_found' : 'error';

      const invoiceDocs = await fetchShipmentInvoices(baseUrl, apiKey, shipmentId);
      const inv: FCDoc = invoiceDocs[0] ?? invoiceByShipment.get(shipmentId) ?? {};

      // ── Cost ────────────────────────────────────────────────────────────
      // What Freightcom actually invoiced. Authoritative: reweighs, fuel and
      // residential surcharges routinely push it past the booking quote.
      const billed = splitCurrency(
        money(inv, 'total_amount', 'totalAmount', 'total', 'amount', 'amount_cad')
        ?? money(s, 'total_amount', 'totalAmount'),
      );
      // The quote captured at booking. Kept separate so the dashboard can say
      // which of the two numbers it is showing.
      const quoted = cadOnly(
        money(s, 'rate_cad', 'rate', 'quoted_rate') ?? money(nested(s, 'total'), 'value'),
      );

      const charges = (inv['charges'] ?? inv['surcharges'] ?? []) as FCDoc[];
      const parts = breakdown(Array.isArray(charges) ? charges : []);

      // ── Addresses, packaging ────────────────────────────────────────────
      const orig = nested(s, 'details', 'origin', 'address') ?? {};
      const dest = nested(s, 'details', 'destination', 'address') ?? {};

      const pkgs = (nested(s, 'details', 'packaging_properties', 'packages') as unknown as FCDoc[] | null) ?? [];
      const weight = pkgs.reduce(
        (sum, p) => sum + (num(nested(p, 'measurements', 'weight'), 'value') ?? 0), 0,
      ) || null;
      const cuboid = pkgs[0] ? nested(pkgs[0], 'measurements', 'cuboid') : null;
      const dimensions = cuboid
        ? { l: num(cuboid, 'l'), w: num(cuboid, 'w'), h: num(cuboid, 'h') }
        : null;

      const state    = str(s, 'state', 'status');
      const invDate  = toDate(inv['invoice_date'] ?? inv['date'] ?? inv['document_date']);
      const bookedAt = toDate(s['created_at'] ?? s['booked_at'] ?? s['createdAt']);

      const row = {
        freightcom_shipment_id: shipmentId,
        carrier: str(s, 'carrier_name', 'carrierName', 'carrier'),
        service: str(s, 'service_name', 'serviceName', 'service'),
        status: mapStatus(state),
        freightcom_status: state,
        status_synced_at: new Date().toISOString(),
        rate_cad: quoted,
        transit_days: (s['transit_time_days'] ?? s['transitTimeDays'] ?? null) as number | null,
        label_url: (s['labels'] as FCDoc[] | undefined)?.[0]?.['url'] as string | null ?? null,
        primary_tracking_number: str(s, 'primary_tracking_number', 'primaryTrackingNumber', 'tracking_number'),
        origin_city: str(orig, 'city'), origin_province: str(orig, 'province', 'state'),
        origin_postal: str(orig, 'postal_code', 'postalCode', 'zip'), origin_country: str(orig, 'country'),
        dest_city: str(dest, 'city'), dest_province: str(dest, 'province', 'state'),
        dest_postal: str(dest, 'postal_code', 'postalCode', 'zip'), dest_country: str(dest, 'country'),
        weight_kg: weight, dimensions_cm: dimensions,
        billed_cad: billed.cad, billed_amount: billed.amount, billed_currency: billed.currency,
        ...parts,
        invoice_number: str(inv, 'invoice_number', 'invoiceNumber', 'id', 'document_id'),
        invoice_date: invDate,
        invoiced_at: toIso(invDate),
        booked_at: toIso(bookedAt),
        picked_up_at: toIso(toDate(s['picked_up_at'] ?? s['pickedUpAt'])),
        estimated_delivery: toDate(s['estimated_delivery'] ?? s['estimatedDelivery']),
        delivered_at: toIso(toDate(s['delivered_at'] ?? s['deliveredAt'])),
        synced_at: new Date().toISOString(),
        raw_payload: mergeRawPayload(stored.get(shipmentId), s),
      };

      // Prune before writing: a field the API omitted came through as null, and
      // writing it back would erase whatever is stored — an operator-entered
      // tracking number, a carrier from the manual import.
      const patch = pruneNulls(row) as Record<string, unknown>;
      // carrier/service are NOT NULL with no default, so a first insert has to
      // supply them even when Freightcom didn't name them. On an update they
      // stay pruned and the stored values survive.
      if (!stored.has(shipmentId)) {
        patch.carrier ??= '';
        patch.service ??= '';
      }

      const { error } = await admin
        .from('shipments')
        .upsert(patch, { onConflict: 'freightcom_shipment_id' });
      if (error) {
        console.error(`Upsert failed for ${shipmentId}: ${error.message}`);
        return 'error';
      }
      return billed.amount !== null ? 'costed' : 'upserted';
    } catch (e) {
      console.error(`Error processing shipment ${shipmentId}:`, e);
      return 'error';
    }
  });

  for (const r of results) {
    if (r === 'costed')        { upserted++; costed++; }
    else if (r === 'upserted')   upserted++;
    else if (r === 'not_found')  notFound++;
    else                         errors++;
  }

  // Every id unknown to the host is the signature of pointing a valid credential
  // at the wrong environment. It is not a quiet "nothing to do" — report it as a
  // failed run so cron.job_run_details and any alerting see it.
  const allMissing = targets.length > 0 && notFound === targets.length;
  if (allMissing) {
    warnings.push(
      `None of the ${targets.length} shipment ids exist on ${baseUrl}. These are live ` +
      `Freightcom transaction numbers — the sandbox host does not know them.`,
    );
  }

  await admin.rpc('match_shipment_serials');
  await admin.rpc('match_shipment_orders');

  const ok = errors === 0 && !allMissing;
  return json({
    ok,
    invoices_fetched: docs.length,
    shipments_targeted: targets.length,
    upserted, costed, not_found: notFound, errors,
    warnings, diagnostics,
  }, ok ? 200 : 502);
}
