// freightcom-rate-probe — rate every confirmed order against the next seven
// PICKUP dates, twice a day for seven days.
// Spec: docs/superpowers/specs/2026-09-22-freightcom-rate-probe-design.md
//
// Why the ship date is swept rather than the clock:
//
//   Freightcom's rate body carries `expected_ship_date`, and nextShipDate() in
//   _shared/freightcom.ts pins it to tomorrow for every existing caller. So
//   re-quoting the same shipment twice a day varies WHEN YOU ASK, not WHEN YOU
//   SHIP, and cannot answer "which day of the week is cheapest to ship on".
//   Each run therefore rates D+1 .. D+7 per order, which also means the
//   cheapest-day answer exists after run 1 instead of after day 7.
//
//   The twice-daily repeat is kept because the rate card does move: freight_quotes
//   holds one order quoted six days apart at $169.24 and then $180.27 (+6.5%).
//   That is a second, independent question and the across-run comparison answers it.
//
// Why this is chunked:
//
//   20260806150000_freightcom_sync_cron_timeout.sql is the post-mortem of a
//   Freightcom job that was killed at 5.001 s on every single run while
//   cron.job_run_details reported "succeeded" 45 times, leaving the dashboard
//   six weeks stale with nothing looking broken. One invocation here handles
//   CHUNK_ORDERS orders and then hands the next chunk to pg_net, so no
//   invocation is ever long enough to be cut off, and a chunk that dies is
//   visible as a run stuck at a cursor rather than as silence.
//
// Env: FREIGHTCOM_API_KEY, FREIGHTCOM_BASE_URL, CRON_SHARED_SECRET,
//      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto-injected).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import {
  buildShipmentDetails, packagesForLineItems, quotableDestinationPostal, shippableUnitCount,
} from '../_shared/freightcom.ts';
import type { FreightcomPackage, QuotableLineItem, ShipDate } from '../_shared/freightcom.ts';
import { flagFor } from '../_shared/freightRateReport.ts';

const DEFAULT_BASE_URL = 'https://customer-external-api.ssd-test.freightcom.com';

// VCycene warehouse — origin for every shipment.
const ORIGIN_POSTAL  = 'L3R9Z7';
const ORIGIN_COUNTRY = 'CA';

// Mirrors SALES_QUEUE_START in app/src/lib/orders.ts. An order older than this
// is in no Sales bucket at all, so it is not in the Confirmed tab either.
const SALES_QUEUE_START = '2026-06-02';

// Two orders per invocation, all seven of an order's ship dates in flight at
// once: 14 rate calls per chunk in two waves. At the observed ~6 s per rate
// that is ~12 s, and even if every call ran to POLL_MAX_TRIES it is ~48 s —
// comfortably inside the wall clock, which is the whole point of chunking.
const CHUNK_ORDERS = 2;
const CONCURRENCY  = 7;

const POLL_MAX_TRIES   = 12;
const POLL_INTERVAL_MS = 2000;

// Thresholds (WARN_CAD / CRITICAL_CAD) live in _shared/freightRateReport.ts so
// the probe that stamps flag_level and the report that renders the flags cannot
// drift apart. They are CAD on the cheapest rate; the API returns CAD for every
// destination including US ones, so nothing is converted.

// A run left 'running' this long was killed mid-chunk; the next cron fire
// retires it rather than trying to resume a chunk whose fate is unknown.
const RUN_STALE_MS = 2 * 60 * 60 * 1000;

type CohortEntry = {
  order_id: string;
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  postal_code: string;
  country: string;
  packages: FreightcomPackage[];
  unit_count: number;
};

type Job = {
  id: string; label: string; started_on: string; days: number;
  ship_dates: number; cohort: CohortEntry[]; status: string;
};

type Run = {
  id: string; job_id: string; run_index: number; day_index: number;
  cursor_index: number; quotes_saved: number; status: string; started_at: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    if (err instanceof Response) return err;
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  await authenticate(req, admin);

  const apiKey  = Deno.env.get('FREIGHTCOM_API_KEY');
  const baseUrl = Deno.env.get('FREIGHTCOM_BASE_URL') ?? DEFAULT_BASE_URL;
  if (!apiKey) return json({ error: 'FREIGHTCOM_API_KEY not configured' }, 500);

  const body = await req.json().catch(() => ({})) as {
    start?: boolean; label?: string; dry_run?: boolean; only_orders?: string[];
  };

  const job = await ensureJob(admin, body);
  if (!job) return json({ ok: true, idle: true, reason: 'no active probe job' });

  const today     = utcToday();
  const dayIndex  = daysBetween(job.started_on, today) + 1;
  if (dayIndex > job.days) {
    await admin.from('freight_rate_probe_jobs').update({ status: 'complete' }).eq('id', job.id);
    return json({ ok: true, idle: true, reason: `campaign finished on day ${job.days}` });
  }

  const run = await currentRun(admin, job, dayIndex);

  const slice = job.cohort.slice(run.cursor_index, run.cursor_index + CHUNK_ORDERS);
  if (slice.length === 0) {
    await finishRun(admin, run);
    return json({ ok: true, run_index: run.run_index, day_index: dayIndex, finished: true });
  }

  const shipDates = upcomingShipDates(job.ship_dates);
  let saved = 0;
  const problems: Array<{ order_ref: string; error: string }> = [];

  for (const entry of slice) {
    try {
      saved += await probeOrder(admin, { job, run, entry, shipDates, apiKey, baseUrl, dryRun: !!body.dry_run });
    } catch (e) {
      problems.push({ order_ref: entry.order_ref, error: (e as Error)?.message ?? String(e) });
    }
  }

  const nextCursor = run.cursor_index + slice.length;
  await admin.from('freight_rate_probe_runs')
    .update({ cursor_index: nextCursor, quotes_saved: run.quotes_saved + saved })
    .eq('id', run.id);

  const done = nextCursor >= job.cohort.length;
  if (done) {
    await finishRun(admin, { ...run, cursor_index: nextCursor });
  } else if (!body.dry_run) {
    // Hand off through pg_net rather than calling our own URL: awaiting that
    // call would keep this isolate alive for the entire run and re-create the
    // wall-clock problem chunking exists to solve.
    const { error } = await admin.rpc('freight_probe_next_chunk');
    if (error) {
      await admin.from('freight_rate_probe_runs')
        .update({ status: 'failed', error: `chunk handoff failed: ${error.message}`, finished_at: new Date().toISOString() })
        .eq('id', run.id);
      return json({ error: `chunk handoff failed: ${error.message}`, saved }, 500);
    }
  }

  return json({
    ok: true,
    job_id: job.id, run_index: run.run_index, day_index: dayIndex,
    cohort_size: job.cohort.length,
    cursor: nextCursor, run_complete: done,
    orders_this_chunk: slice.map(s => s.order_ref),
    quotes_saved: saved,
    ...(problems.length ? { problems } : {}),
  });
}

// ---------------------------------------------------------------------------
// Job + run bookkeeping
// ---------------------------------------------------------------------------

async function ensureJob(
  admin: SupabaseClient,
  body: { start?: boolean; label?: string; only_orders?: string[] },
): Promise<Job | null> {
  const { data: existing } = await admin
    .from('freight_rate_probe_jobs')
    .select('*').eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) return existing as Job;
  if (!body.start) return null;

  // The cohort is frozen here, once. The Confirmed tab is live, and a customer
  // entering or leaving mid-week would make the week's numbers incomparable.
  let cohort = await loadConfirmedCohort(admin);
  if (body.only_orders?.length) {
    const want = new Set(body.only_orders.map(s => s.toLowerCase()));
    cohort = cohort.filter(c => want.has(c.order_ref.toLowerCase()) || want.has(c.order_id));
  }
  if (cohort.length === 0) throw json({ error: 'Confirmed list is empty — nothing to probe' }, 400);

  const label = body.label ?? `confirmed-${utcToday()}`;
  const { data, error } = await admin
    .from('freight_rate_probe_jobs')
    .insert({ label, cohort, note: `${cohort.length} confirmed orders frozen at job start` })
    .select('*').single();
  if (error) throw json({ error: `Could not open probe job: ${error.message}` }, 500);
  return data as Job;
}

async function currentRun(admin: SupabaseClient, job: Job, dayIndex: number): Promise<Run> {
  const { data: running } = await admin
    .from('freight_rate_probe_runs')
    .select('*').eq('job_id', job.id).eq('status', 'running')
    .order('run_index', { ascending: false }).limit(1).maybeSingle();

  if (running) {
    const age = Date.now() - new Date((running as Run).started_at).getTime();
    if (age < RUN_STALE_MS) return running as Run;
    await admin.from('freight_rate_probe_runs')
      .update({ status: 'failed', error: 'abandoned — no chunk completed within 2h', finished_at: new Date().toISOString() })
      .eq('id', (running as Run).id);
  }

  const { data: last } = await admin
    .from('freight_rate_probe_runs')
    .select('run_index').eq('job_id', job.id)
    .order('run_index', { ascending: false }).limit(1).maybeSingle();
  const runIndex = ((last as { run_index: number } | null)?.run_index ?? 0) + 1;

  const { data, error } = await admin
    .from('freight_rate_probe_runs')
    .insert({ job_id: job.id, run_index: runIndex, day_index: dayIndex })
    .select('*').single();
  if (error) throw json({ error: `Could not open run: ${error.message}` }, 500);
  return data as Run;
}

async function finishRun(admin: SupabaseClient, run: Run): Promise<void> {
  await admin.from('freight_rate_probe_runs')
    .update({ status: 'complete', finished_at: new Date().toISOString() })
    .eq('id', run.id);
}

// ---------------------------------------------------------------------------
// Cohort — the Sales > Confirmed tab, rebuilt server-side
// ---------------------------------------------------------------------------

/** Mirrors bucketOrders()'s `approved` bucket in app/src/lib/orders.ts. Kept in
 *  step by hand: there is no shared module between the browser bundle and Deno,
 *  and a cohort that silently drifts from what Sales shows is worse than one
 *  that is obviously a copy. */
async function loadConfirmedCohort(admin: SupabaseClient): Promise<CohortEntry[]> {
  const [{ data: orders }, { data: queue }, { data: units }] = await Promise.all([
    admin.from('orders')
      .select('id, order_ref, customer_name, customer_email, status, kind, postal_code, country, created_at, reconcile_outcome, line_items, address_match, address_google_postal')
      .limit(10000),
    admin.from('fulfillment_queue').select('order_id, step, fulfilled_at').limit(10000),
    admin.from('units').select('customer_name, status').eq('status', 'shipped').limit(10000),
  ]);

  const fulfilled = new Set(
    (queue ?? []).filter((q: Record<string, unknown>) => (q.step as number) >= 6 || q.fulfilled_at)
      .map((q: Record<string, unknown>) => q.order_id as string),
  );
  const shipped = new Set(
    (units ?? []).map((u: Record<string, unknown>) => ((u.customer_name as string) ?? '').toLowerCase().trim()),
  );
  const start = new Date(SALES_QUEUE_START).getTime();

  const cohort: CohortEntry[] = [];
  for (const o of (orders ?? []) as Record<string, unknown>[]) {
    if (o.kind === 'replacement') continue;
    if (new Date(o.created_at as string).getTime() < start) continue;
    if (o.status !== 'approved') continue;
    if (fulfilled.has(o.id as string)) continue;
    if (o.reconcile_outcome !== 'open'
        && shipped.has(((o.customer_name as string) ?? '').toLowerCase().trim())) continue;

    // Rate the postal code verification proved right, not the one the customer
    // typed, when those differ — a confident number about a place the parcel
    // will never go is worse than no number.
    const dest = quotableDestinationPostal(o as Parameters<typeof quotableDestinationPostal>[0]);
    if (!dest.postal_code) continue;

    const lineItems = (o.line_items ?? []) as QuotableLineItem[];
    cohort.push({
      order_id: o.id as string,
      order_ref: (o.order_ref as string) ?? '',
      customer_name: (o.customer_name as string) ?? '',
      customer_email: (o.customer_email as string) ?? null,
      postal_code: dest.postal_code,
      country: (o.country as string) ?? 'CA',
      packages: packagesForLineItems(lineItems),
      unit_count: shippableUnitCount(lineItems),
    });
  }
  return cohort;
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

async function probeOrder(admin: SupabaseClient, ctx: {
  job: Job; run: Run; entry: CohortEntry; shipDates: Date[];
  apiKey: string; baseUrl: string; dryRun: boolean;
}): Promise<number> {
  const { job, run, entry, shipDates, apiKey, baseUrl, dryRun } = ctx;

  const results = await mapWithConcurrency(shipDates, CONCURRENCY, async (when) => {
    const rates = await rateOnce(apiKey, baseUrl, entry, toShipDate(when));
    return { when, rates };
  });

  const rows: Record<string, unknown>[] = [];
  for (const { when, rates } of results) {
    // Cheapest-of-the-day is the only rate anyone will act on, so it is marked
    // here rather than recomputed by every reader of the table.
    let cheapest = Number.POSITIVE_INFINITY;
    for (const r of rates) if (r.rate_cad !== null && r.rate_cad < cheapest) cheapest = r.rate_cad;

    for (const r of rates) {
      const isCheapest = r.rate_cad !== null && r.rate_cad === cheapest;
      rows.push({
        run_id: run.id, job_id: job.id,
        order_id: entry.order_id, order_ref: entry.order_ref, customer_name: entry.customer_name,
        dest_postal: entry.postal_code, dest_country: entry.country,
        ship_date: isoDate(when), ship_weekday: when.getUTCDay(),
        run_index: run.run_index,
        carrier: r.carrier, service_level: r.service_level,
        rate_cad: r.rate_cad, transit_days: r.transit_days,
        package_count: entry.packages.length,
        is_cheapest: isCheapest,
        flag_level: isCheapest ? flagFor(r.rate_cad) : 'none',
        raw: r.raw,
      });
    }
  }

  if (dryRun || rows.length === 0) return rows.length;
  const { error } = await admin.from('freight_rate_probes').insert(rows);
  if (error) throw new Error(`insert failed: ${error.message}`);
  return rows.length;
}

type ParsedRate = {
  carrier: string; service_level: string;
  rate_cad: number | null; transit_days: number | null; raw: unknown;
};

async function rateOnce(
  apiKey: string, baseUrl: string, entry: CohortEntry, shipDate: ShipDate,
): Promise<ParsedRate[]> {
  const rateReq = {
    details: buildShipmentDetails({
      origin:      { postal_code: ORIGIN_POSTAL, country: ORIGIN_COUNTRY },
      destination: { postal_code: entry.postal_code, country: entry.country, email: entry.customer_email },
      packages:    entry.packages,
      shipDate,
    }),
  };

  const initRes = await fetch(`${baseUrl}/rate`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(rateReq),
  });

  if (initRes.status === 429) {
    // Worth its own message: this account's token was previously deactivated by
    // Freightcom for INACTIVITY, and this job is the most traffic it has ever
    // generated, so throttling is the expected first sign of trouble.
    throw new Error(`Freightcom rate-limited us (429) on ${entry.order_ref} for ${fmtShipDate(shipDate)}`);
  }
  if (initRes.status !== 202) {
    const errBody = await initRes.json().catch(() => ({}));
    throw new Error(`rate request failed (${initRes.status}): ${summarize(errBody)}`);
  }

  const { request_id } = await initRes.json() as { request_id: string };

  let rates: Record<string, unknown>[] = [];
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await delay(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${baseUrl}/rate/${request_id}`, { headers: { Authorization: apiKey } });
    if (!pollRes.ok) break;
    const pollData = await pollRes.json() as { status?: { done: boolean }; rates?: Record<string, unknown>[] };
    rates = pollData.rates ?? [];
    if (pollData.status?.done) break;
  }

  return rates.map((rate) => {
    const total   = rate.total as { value?: string; currency?: string } | undefined;
    const cents   = parseInt(total?.value ?? '0', 10);
    return {
      carrier: (rate.carrier_name as string) ?? '',
      service_level: `${(rate.carrier_name as string) ?? ''} — ${(rate.service_name as string) ?? ''}`,
      // CAD for every destination on this account, US included, so a non-CAD
      // total is a surprise worth storing as null rather than as a number in
      // the wrong currency.
      rate_cad: total?.currency === 'CAD' && Number.isFinite(cents) ? cents / 100 : null,
      transit_days: (rate.transit_time_not_available as boolean)
        ? null : ((rate.transit_time_days as number | null) ?? null),
      raw: rate,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** D+1 .. D+n, UTC. D+0 is excluded: a carrier cannot collect a parcel that has
 *  not been packed, and every other caller already treats tomorrow as the
 *  earliest pickup. */
function upcomingShipDates(n: number): Date[] {
  const out: Date[] = [];
  for (let i = 1; i <= n; i++) out.push(new Date(Date.now() + i * 86_400_000));
  return out;
}

function toShipDate(d: Date): ShipDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function fmtShipDate(s: ShipDate): string {
  return `${s.year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
}
function utcToday(): string { return new Date().toISOString().slice(0, 10); }
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Freightcom rejections read `{ message, data: { "<field path>": "<why>" } }`. */
function summarize(body: unknown): string {
  const b = body as { message?: string; data?: Record<string, string> } | null;
  const fields = Object.entries(b?.data ?? {}).map(([k, v]) => `${k} — ${v}`);
  return [b?.message, ...fields].filter(Boolean).join('; ') || 'no detail returned';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
