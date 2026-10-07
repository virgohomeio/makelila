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
// ── What this API can and cannot do (measured 2026-08-11, live key) ────────
// Two id spaces, and they do not meet:
//
//   GET /finance/documents?start_date&end_date  → 200. The only bulk read there
//     is. Documents are keyed by `number` — the portal's transaction number,
//     which is exactly what shipments.freightcom_shipment_id holds.
//   GET /shipment/{id}                          → exists, but only resolves ids
//     minted by POST /shipment. Portal-booked shipments 404 here permanently.
//   GET /shipments, /shipment, /shipments/search, /track/{n}  → no such routes
//     (API Gateway 403s). THERE IS NO WAY TO LIST SHIPMENTS.
//
// Consequences worth understanding before changing anything here:
//   • Costs, dates and existence come from finance documents. Carrier, service,
//     tracking, addresses and status come from GET /shipment/{id} — so for
//     portal-booked shipments we get money and nothing else. The CSV importer
//     (scripts/import-freightcom-tracking.mjs) is what fills in the rest.
//   • A shipment is invisible to us until Freightcom raises a finance document
//     for it, which lags shipping by up to a billing cycle. The dashboard can
//     therefore never be a live mirror of the Freightcom portal by API alone.
//
// ── Writes ─────────────────────────────────────────────────────────────────
// Per the repo's system-of-record rule, this sync adds what the API knows and
// leaves everything else alone: null fields are pruned before the upsert rather
// than overwriting stored values, and raw_payload is merged so the hand-loaded
// provenance keys the dashboard derives Customer and Direction from survive.
//
// Body (all optional):
//   { probe?: boolean }          — report the finance/auth state, write nothing
//   { limit?: number }           — cap shipments processed this run
//   { create_missing?: boolean } — also insert shipments that appear in finance
//     documents but not on the dashboard. Off by default: those rows carry a
//     cost and a date and nothing else.
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
  documentNumber, pickCostDocument, docDate,
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

/** Groups finance documents by the transaction number they belong to. */
function groupByNumber(docs: FCDoc[]): Map<string, FCDoc[]> {
  const out = new Map<string, FCDoc[]>();
  for (const doc of docs) {
    const num = documentNumber(doc);
    if (!num) continue;
    const bucket = out.get(num);
    if (bucket) bucket.push(doc);
    else out.set(num, [doc]);
  }
  return out;
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const body = await req.json().catch(() => ({})) as
    { probe?: boolean; limit?: number; create_missing?: boolean };
  try { return await handle(body?.probe === true, body?.limit, body?.create_missing === true); }
  catch (err) {
    return json({ ok: false, error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(
  probeOnly: boolean, limit?: number, createMissing = false,
): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey      = Deno.env.get('FREIGHTCOM_API_KEY')?.trim();
  // .trim() is not cosmetic. A secret pasted into the Supabase dashboard arrives
  // with trailing newlines — observed 2026-08-11, when FREIGHTCOM_BASE_URL held
  // "https://external-api.freightcom.com\n\n". The WHATWG URL parser strips them
  // so requests still worked, but `baseUrl === LIVE_BASE_URL` was false, and the
  // function reported environment "sandbox" while talking to production.
  const baseUrlRaw  = Deno.env.get('FREIGHTCOM_BASE_URL');
  const baseUrlEnv  = baseUrlRaw?.trim() || undefined;
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
  //
  // This is the ONLY bulk discovery the API offers. Measured 2026-08-11 with a
  // live key: there is no list-shipments route (GET /shipments, /shipment,
  // /shipments/search and /track all return API-Gateway 403s, meaning no such
  // route), and GET /shipment/{id} — which does exist — does not recognise the
  // portal's transaction numbers. So finance documents are how we learn that a
  // shipment exists at all. See docs/freightcom-live-credentials.md.
  const probes: Probe[] = [];
  const { docs, authOk } = await fetchFinanceDocs(baseUrl, apiKey, probes);
  const docsByNumber = groupByNumber(docs);
  const invoiceIds = new Set(docsByNumber.keys());

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

  // The authoritative cost document per transaction number — one shipment can
  // have an order-details document, a card invoice and a refund.
  const invoiceByShipment = new Map<string, FCDoc>();
  for (const [num, group] of docsByNumber) {
    const pick = pickCostDocument(group);
    if (pick) invoiceByShipment.set(num, pick);
  }

  // By default reconcile only what the dashboard already shows. Shipments known
  // solely to Freightcom's finance API carry no carrier, customer or tracking —
  // creating them silently would fill the dashboard with rows that have a cost
  // and nothing else, so it is opt-in.
  const allIds = createMissing
    ? [...new Set([...stored.keys(), ...invoiceIds])]
    : [...stored.keys()];
  const cap = Math.max(0, Math.min(limit ?? MAX_SHIPMENTS, MAX_SHIPMENTS));
  const targets = allIds.slice(0, cap);
  if (allIds.length > targets.length) {
    warnings.push(`${allIds.length - targets.length} shipment(s) not processed this run (cap ${cap}).`);
  }

  let upserted = 0, costed = 0, notFound = 0, errors = 0;

  const results = await mapPool(targets, CONCURRENCY, async (shipmentId) => {
    try {
      // Shipment detail is a bonus, not a precondition.
      //
      // GET /shipment/{id} only resolves ids minted by POST /shipment — i.e.
      // shipments booked through this API. Anything booked in the Freightcom
      // portal 404s here forever. Treating that as a dead end (which the previous
      // version did, by returning early) threw away the finance document we had
      // already fetched, so a shipment we knew the cost of got recorded as
      // "not found" and the Rate (CAD) column stayed empty. Fetch what detail we
      // can, then write whatever we ended up with.
      const { doc: s, status } = await fetchShipment(baseUrl, apiKey, shipmentId);
      if (!s && status !== 404) return 'error';

      const invoiceDocs = s ? await fetchShipmentInvoices(baseUrl, apiKey, shipmentId) : [];
      const inv: FCDoc = invoiceDocs[0] ?? invoiceByShipment.get(shipmentId) ?? {};

      // Nothing from either source — genuinely nothing to say about this id.
      if (!s && !Object.keys(inv).length) return 'not_found';

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

      // `s` is null for every portal-booked shipment. Index through a stand-in so
      // the field readers below degrade to null instead of throwing.
      const sd: FCDoc = s ?? {};

      const state    = str(s, 'state', 'status');
      const invDate  = docDate(inv);
      const bookedAt = toDate(sd['created_at'] ?? sd['booked_at'] ?? sd['createdAt']);

      const row = {
        freightcom_shipment_id: shipmentId,
        carrier: str(s, 'carrier_name', 'carrierName', 'carrier'),
        service: str(s, 'service_name', 'serviceName', 'service'),
        // Only claim a status when the shipment API actually told us one.
        // mapStatus(null) returns 'booked', which would quietly regress a row
        // the CSV import had already marked delivered.
        status: state ? mapStatus(state) : null,
        freightcom_status: state,
        status_synced_at: state ? new Date().toISOString() : null,
        rate_cad: quoted,
        transit_days: (sd['transit_time_days'] ?? sd['transitTimeDays'] ?? null) as number | null,
        label_url: (sd['labels'] as FCDoc[] | undefined)?.[0]?.['url'] as string | null ?? null,
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
        picked_up_at: toIso(toDate(sd['picked_up_at'] ?? sd['pickedUpAt'])),
        estimated_delivery: toDate(sd['estimated_delivery'] ?? sd['estimatedDelivery']),
        delivered_at: toIso(toDate(sd['delivered_at'] ?? sd['deliveredAt'])),
        synced_at: new Date().toISOString(),
        // With no shipment payload there is nothing to merge in, and writing the
        // merge result anyway would rewrite the column for no reason. Leave it.
        raw_payload: s ? mergeRawPayload(stored.get(shipmentId), s) : null,
      };

      // Prune before writing: a field the API omitted came through as null, and
      // writing it back would erase whatever is stored — an operator-entered
      // tracking number, a carrier from the manual import.
      const patch = pruneNulls(row) as Record<string, unknown>;

      // Insert and update take different routes, for the same reason
      // scripts/import-freightcom-tracking.mjs splits POST from PATCH.
      //
      // PostgREST's .upsert() is INSERT ... ON CONFLICT, and Postgres validates
      // the *proposed* row before it ever gets to the conflict clause. carrier
      // and service are NOT NULL with no default, so an update that legitimately
      // omits them fails with 23502 on carrier — which is precisely what happened
      // on the first live run: 38 targets, 38 errors, 0 rows written. An UPDATE
      // touches only the columns supplied, so a sparse API response can no longer
      // blank a carrier the CSV import established.
      let error;
      if (stored.has(shipmentId)) {
        ({ error } = await admin
          .from('shipments')
          .update(patch)
          .eq('freightcom_shipment_id', shipmentId));
      } else {
        patch.carrier ??= '';
        patch.service ??= '';
        ({ error } = await admin.from('shipments').insert(patch));
      }
      if (error) {
        console.error(`Write failed for ${shipmentId}: ${error.message}`);
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

  // An id with neither a shipment payload nor a finance document is invisible to
  // this account. All of them being invisible is the signature of a credential
  // pointed at the wrong environment — not a quiet "nothing to do", so it is
  // reported as a failed run for cron.job_run_details and any alerting.
  const allMissing = targets.length > 0 && notFound === targets.length;
  if (allMissing) {
    warnings.push(
      `None of the ${targets.length} shipment ids are known to ${baseUrl} — neither ` +
      `GET /shipment/{id} nor any finance document names them. Check that ` +
      `FREIGHTCOM_API_KEY belongs to the account that booked these shipments.`,
    );
  }

  // Shipments Freightcom has billed us for that the dashboard has never heard
  // of. Surfaced on every run so the gap is visible rather than inferred; pass
  // { create_missing: true } to bring them in.
  const unknownToUs = [...invoiceIds].filter((id) => !stored.has(id));
  if (unknownToUs.length && !createMissing) {
    warnings.push(
      `${unknownToUs.length} shipment(s) appear in Freightcom's finance documents but ` +
      `are not on the dashboard. Re-run with {"create_missing":true} to add them ` +
      `(they will carry cost and date only — no carrier, tracking or customer).`,
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
    unknown_to_dashboard: unknownToUs.length,
    warnings, diagnostics,
  }, ok ? 200 : 502);
}
