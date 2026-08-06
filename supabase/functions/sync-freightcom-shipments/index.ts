// sync-freightcom-shipments
//
// Pulls shipments from the Freightcom API into public.shipments.
//
// ⚠ HISTORY (2026-08-06): this function existed only as an ad-hoc deployment
// (entrypoint /tmp/user_fn_…) with no copy in the repo, so nobody could review
// or redeploy it. This file is that deployment, restored to source control with
// the diagnostics below added. Behaviour is otherwise unchanged.
//
// Discovery strategy:
//   1. POST /finance/documents (wide date range) → invoice list with shipment IDs
//   2. GET /shipment/{id} per discovered ID → full details
//   3. GET /finance/invoices-for-shipment-id/{id} → cost breakdown
//   4. match_shipment_serials() / match_shipment_orders() to link units + orders
//
// KNOWN LIMITATION — discovery is invoice-driven. A shipment is only found once
// Freightcom has raised a finance document for it, so anything booked in the
// last billing cycle is invisible here no matter how often this runs. If the
// dashboard needs to show shipments the day they go out, discovery has to come
// from a shipment-listing endpoint (or from makelila's own bookings), not from
// invoices.
//
// The `probe` diagnostics exist because every non-OK response used to be
// swallowed into an empty array: an expired key, a wrong environment and a
// genuinely empty account all looked identical ("0 invoices"). They are
// reported on every run so a silent-zero can be told apart from a failure.
//
// Body (all optional): { probe?: boolean }  — probe:true returns response body
//                       snippets from the finance calls without upserting.
//
// Env vars:
//   FREIGHTCOM_API_KEY   — bare token (no Bearer prefix)
//   FREIGHTCOM_BASE_URL  — ⚠ defaults to LIVE here, but freightcom-book /
//     -invoices / -status / -tracking all default to the ssd-test SANDBOX host.
//     If this var is unset, this sync and the rest of the integration are
//     talking to two different Freightcom environments. Set it explicitly.
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_BASE_URL = 'https://external-api.freightcom.com';
const DAYS_BACK = 730; // 2 years of history

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type FCDoc = Record<string, unknown>;

/** What a finance call actually did — surfaced in the response so a zero-result
 *  run can be diagnosed without redeploying. */
type Probe = { call: string; status: number | null; ok: boolean; body_snippet: string };

function envelope(data: unknown): FCDoc[] | null {
  if (Array.isArray(data)) return data as FCDoc[];
  for (const key of ['documents', 'invoices', 'items', 'data', 'results']) {
    const v = (data as FCDoc)?.[key];
    if (Array.isArray(v)) return v as FCDoc[];
  }
  return null;
}

async function fetchFinanceDocs(
  baseUrl: string, apiKey: string, probes: Probe[],
): Promise<FCDoc[]> {
  const to   = new Date();
  const from = new Date(Date.now() - DAYS_BACK * 86_400_000);
  const toObj   = { year: to.getUTCFullYear(),   month: to.getUTCMonth() + 1,   day: to.getUTCDate() };
  const fromObj = { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() };

  const record = async (call: string, res: Response): Promise<unknown | null> => {
    const text = await res.text();
    probes.push({ call, status: res.status, ok: res.ok, body_snippet: text.slice(0, 300) });
    if (!res.ok) return null;
    try { return JSON.parse(text); } catch { return null; }
  };

  const postRes = await fetch(`${baseUrl}/finance/documents`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromObj, to: toObj }),
  });
  const postData = await record('POST /finance/documents', postRes);
  if (postData !== null) {
    const rows = envelope(postData);
    if (rows) return rows;
  }

  const params = new URLSearchParams({
    from_year:  String(fromObj.year),  from_month: String(fromObj.month),  from_day: String(fromObj.day),
    to_year:    String(toObj.year),    to_month:   String(toObj.month),    to_day:   String(toObj.day),
  });
  const getRes = await fetch(`${baseUrl}/finance/documents?${params}`, {
    headers: { Authorization: apiKey },
  });
  const getData = await record('GET /finance/documents', getRes);
  if (getData !== null) {
    const rows = envelope(getData);
    if (rows) return rows;
  }
  return [];
}

function extractShipmentIds(docs: FCDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const doc of docs) {
    for (const field of ['shipment_id', 'shipmentId', 'freight_shipment_id']) {
      const v = doc[field];
      if (v && typeof v === 'string') ids.add(v);
      if (v && typeof v === 'number') ids.add(String(v));
    }
    const lines = doc['line_items'] as FCDoc[] | undefined
               ?? doc['lineItems'] as FCDoc[] | undefined
               ?? doc['items'] as FCDoc[] | undefined
               ?? doc['shipments'] as FCDoc[] | undefined;
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

async function fetchShipment(baseUrl: string, apiKey: string, shipmentId: string): Promise<FCDoc | null> {
  const res = await fetch(`${baseUrl}/shipment/${encodeURIComponent(shipmentId)}`, {
    headers: { Authorization: apiKey },
  });
  if (res.status === 202) {
    await delay(2000);
    const retry = await fetch(`${baseUrl}/shipment/${encodeURIComponent(shipmentId)}`, {
      headers: { Authorization: apiKey },
    });
    if (!retry.ok) return null;
    return (await retry.json()) as FCDoc;
  }
  if (!res.ok) return null;
  return (await res.json()) as FCDoc;
}

async function fetchShipmentInvoices(baseUrl: string, apiKey: string, shipmentId: string): Promise<FCDoc[]> {
  const res = await fetch(`${baseUrl}/finance/invoices-for-shipment-id/${encodeURIComponent(shipmentId)}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function str(obj: FCDoc, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && v !== '') return String(v);
  }
  return null;
}

function num(obj: FCDoc | null, ...keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined) {
      if (typeof v === 'object' && (v as FCDoc).value !== undefined) {
        return parseInt(String((v as FCDoc).value), 10) / 100;
      }
      const parsed = parseFloat(String(v));
      if (!isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function nested(obj: FCDoc, ...path: string[]): FCDoc | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as FCDoc)[k];
  }
  return (cur as FCDoc) ?? null;
}

function toDate(obj: FCDoc | string | null): string | null {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.slice(0, 10);
  const { year, month, day } = obj as { year?: number; month?: number; day?: number };
  if (year && month && day) return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return null;
}

function mapStatus(state: string | null): string {
  if (!state) return 'booked';
  const s = state.toLowerCase();
  if (s.includes('transit') || s.includes('in-transit')) return 'in_transit';
  if (s.includes('deliver')) return 'delivered';
  if (s.includes('exception') || s.includes('error')) return 'exception';
  if (s.includes('missing') || s.includes('lost')) return 'missing';
  if (s.includes('cancel')) return 'cancelled';
  return 'booked';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  let probeOnly = false;
  try {
    const body = await req.json().catch(() => ({})) as { probe?: boolean };
    probeOnly = body?.probe === true;
  } catch { /* no body = normal run */ }
  try { return await handle(probeOnly); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(probeOnly: boolean): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey      = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrlEnv  = Deno.env.get('FREIGHTCOM_BASE_URL');
  const baseUrl     = baseUrlEnv ?? DEFAULT_BASE_URL;

  if (!apiKey) return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const probes: Probe[] = [];
  const docs = await fetchFinanceDocs(baseUrl, apiKey, probes);
  const shipmentIds = extractShipmentIds(docs);

  // Environment/credential facts that make a zero-result run interpretable.
  const diagnostics = {
    base_url: baseUrl,
    base_url_from_env: baseUrlEnv !== undefined,
    api_key_len: apiKey.length,
    probes,
  };

  if (probeOnly) {
    return json({ ok: true, probe: true, invoices_fetched: docs.length,
                  shipment_ids_found: shipmentIds.size, diagnostics });
  }

  const invoiceByShipment = new Map<string, FCDoc>();
  for (const doc of docs) {
    const sid = str(doc, 'shipment_id', 'shipmentId', 'freight_shipment_id');
    if (sid) invoiceByShipment.set(sid, doc);
    const lines = (doc['line_items'] ?? doc['lineItems'] ?? doc['items'] ?? doc['shipments'] ?? []) as FCDoc[];
    for (const line of lines) {
      const lsid = str(line, 'shipment_id', 'shipmentId', 'id');
      if (lsid) invoiceByShipment.set(lsid, doc);
    }
  }

  let upserted = 0;
  let errors   = 0;

  for (const shipmentId of shipmentIds) {
    try {
      const s = await fetchShipment(baseUrl, apiKey, shipmentId);
      if (!s) { errors++; continue; }

      const invoiceDocs = await fetchShipmentInvoices(baseUrl, apiKey, shipmentId);
      const inv: FCDoc = invoiceDocs[0] ?? invoiceByShipment.get(shipmentId) ?? {};

      const trackingNum = str(s, 'primary_tracking_number', 'primaryTrackingNumber', 'tracking_number');
      const carrier     = str(s, 'carrier_name', 'carrierName', 'carrier');
      const service     = str(s, 'service_name', 'serviceName', 'service');
      const state       = str(s, 'state', 'status');
      const labelUrl    = (s['labels'] as FCDoc[] | undefined)?.[0]?.['url'] as string | null ?? null;

      const bookedAt    = toDate(nested(s, 'created_at') ?? nested(s, 'booked_at') ?? nested(s, 'createdAt') ?? (s['created_at'] as string | null));
      const pickedUpAt  = toDate(nested(s, 'picked_up_at') ?? nested(s, 'pickedUpAt') ?? (s['picked_up_at'] as string | null));
      const deliveredAt = toDate(nested(s, 'delivered_at') ?? nested(s, 'deliveredAt') ?? (s['delivered_at'] as string | null));
      const estDelivery = toDate(nested(s, 'estimated_delivery') ?? nested(s, 'estimatedDelivery') ?? (s['estimated_delivery'] as string | null));

      const orig = nested(s, 'details', 'origin', 'address') ?? {};
      const dest = nested(s, 'details', 'destination', 'address') ?? {};

      const pkgs = (nested(s, 'details', 'packaging_properties', 'packages') as unknown as FCDoc[] | null) ?? [];
      const totalWeightKg = pkgs.reduce((sum, p) => sum + (num(nested(p, 'measurements', 'weight'), 'value') ?? 0), 0) || null;
      const cuboid = pkgs[0] ? nested(pkgs[0] as FCDoc, 'measurements', 'cuboid') : null;
      const dimensions = cuboid ? { l: num(cuboid, 'l'), w: num(cuboid, 'w'), h: num(cuboid, 'h') } : null;

      const billedCad = num(inv, 'total_amount', 'totalAmount', 'total', 'amount_cad')
                     ?? num(s,   'total_amount', 'totalAmount');
      const invNumber = str(inv, 'invoice_number', 'invoiceNumber', 'id', 'document_id');
      const invDate   = toDate(nested(inv, 'invoice_date') ?? nested(inv, 'date') ?? nested(inv, 'document_date') ?? (inv['invoice_date'] as string | null));

      const charges = ((inv['charges'] ?? inv['surcharges'] ?? []) as FCDoc[]);
      let baseCad = null as number | null, fuelCad = null as number | null;
      let resCad  = null as number | null, remoteCad = null as number | null;
      const otherSurcharges: { name: string; amount_cad: number }[] = [];
      for (const charge of charges) {
        const name = str(charge, 'name', 'description', 'type') ?? '';
        const amt  = num(charge, 'amount', 'value');
        if (amt === null) continue;
        const nl = name.toLowerCase();
        if (nl.includes('base') || nl.includes('freight')) baseCad = amt;
        else if (nl.includes('fuel')) fuelCad = amt;
        else if (nl.includes('residential') || nl.includes('resi')) resCad = amt;
        else if (nl.includes('remote') || nl.includes('rural')) remoteCad = amt;
        else otherSurcharges.push({ name, amount_cad: amt });
      }

      // Quoted rate. Falls back to the invoiced total so the Rate column is
      // never empty for a shipment we have a real cost for.
      const rateCad = num(s, 'rate_cad', 'rate', 'quoted_rate')
                   ?? num(nested(s, 'total'), 'value')
                   ?? billedCad;
      const transitDays = (s['transit_time_days'] ?? s['transitTimeDays'] ?? null) as number | null;

      const row = {
        freightcom_shipment_id: shipmentId,
        carrier: carrier ?? '', service: service ?? '',
        status: mapStatus(state), rate_cad: rateCad, transit_days: transitDays,
        label_url: labelUrl, primary_tracking_number: trackingNum,
        origin_city: str(orig, 'city'), origin_province: str(orig, 'province', 'state'),
        origin_postal: str(orig, 'postal_code', 'postalCode', 'zip'), origin_country: str(orig, 'country') ?? 'CA',
        dest_city: str(dest, 'city'), dest_province: str(dest, 'province', 'state'),
        dest_postal: str(dest, 'postal_code', 'postalCode', 'zip'), dest_country: str(dest, 'country') ?? 'CA',
        weight_kg: totalWeightKg, dimensions_cm: dimensions,
        billed_cad: billedCad, base_charge_cad: baseCad, fuel_surcharge_cad: fuelCad,
        residential_surcharge_cad: resCad, remote_surcharge_cad: remoteCad,
        other_surcharges: otherSurcharges.length ? otherSurcharges : null,
        invoice_number: invNumber, invoice_date: invDate,
        invoiced_at: invDate ? new Date(invDate).toISOString() : null,
        booked_at: bookedAt ? new Date(bookedAt).toISOString() : new Date().toISOString(),
        picked_up_at: pickedUpAt ? new Date(pickedUpAt).toISOString() : null,
        estimated_delivery: estDelivery,
        delivered_at: deliveredAt ? new Date(deliveredAt).toISOString() : null,
        synced_at: new Date().toISOString(), raw_payload: s,
      };

      await admin.from('shipments').upsert(row, { onConflict: 'freightcom_shipment_id' });
      upserted++;
    } catch (e) {
      console.error(`Error processing shipment ${shipmentId}:`, e);
      errors++;
    }
  }

  await admin.rpc('match_shipment_serials');
  await admin.rpc('match_shipment_orders');

  return json({
    ok: true,
    invoices_fetched: docs.length,
    shipment_ids_found: shipmentIds.size,
    upserted,
    errors,
    diagnostics,
  });
}
