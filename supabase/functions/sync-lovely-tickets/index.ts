// Sync Lovely app damage reports into makelila support tickets.
//
// Reads public.damage_reports from the Lovely Supabase project and inserts one
// service_tickets row (source = 'lovely_app') per report not yet synced.
// service_tickets.lovely_report_id is the dedupe key. INSERT-ONLY: an existing
// ticket is never updated, so operator edits are never clobbered.
//
// Runs every 15 minutes via pg_cron (sync-lovely-tickets-15min). The first run
// after deploy is the backfill; there is no separate backfill path.
// Gracefully no-ops when the Lovely credentials are not set.
//
// Required env vars:
//   SUPABASE_URL                — write target (makeLILA project)
//   SUPABASE_SERVICE_ROLE_KEY   — service role for makeLILA writes
//   TELEMETRY_SUPABASE_URL      — read source (Lovely project)
//   TELEMETRY_SUPABASE_ANON_KEY — anon key; damage_reports is anon-readable
//
// Auth: cron-only (X-Cron-Secret header required, matching CRON_SHARED_SECRET).
//
// Spec: docs/superpowers/specs/2026-10-05-lovely-app-tickets-in-support-design.md

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';
import {
  normalizeSerial, isLookupSafeSerial, resolveCustomer, reportToTicket,
  type DamageReport, type CustomerLookups,
} from './mapReport.ts';

// Inline corsHeaders — avoids module-resolution issues at deploy time.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// PostgREST caps a response at max_rows (1000 on hosted Supabase).
const PAGE = 1_000;
// Keeps `.in()` filters well inside URL length limits (100 UUIDs ≈ 4 KB).
const IN_CHUNK = 100;
const UNIQUE_VIOLATION = '23505';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return jsonResponse({ error: `Uncaught: ${msg}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const lovelyUrl   = Deno.env.get('TELEMETRY_SUPABASE_URL');
  const lovelyKey   = Deno.env.get('TELEMETRY_SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'cron') {
    return jsonResponse({ error: 'This function is cron-only — use the X-Cron-Secret header.' }, 403);
  }

  if (!lovelyUrl || !lovelyKey) {
    return jsonResponse({
      skipped: true,
      reason: 'TELEMETRY_SUPABASE_URL or TELEMETRY_SUPABASE_ANON_KEY not configured — inert until secrets are set',
    }, 200);
  }
  const lovely = createClient(lovelyUrl, lovelyKey);

  // Step 1: every damage report, oldest first so ticket numbers follow filing order.
  const reports: DamageReport[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await lovely
      .from('damage_reports')
      .select('id, user_id, serial_number, notes, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonResponse({ error: `Failed to fetch damage_reports: ${error.message}` }, 500);
    const batch = (data ?? []) as DamageReport[];
    reports.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Step 2: drop the ones already synced.
  const synced = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('service_tickets')
      .select('lovely_report_id')
      .not('lovely_report_id', 'is', null)
      .order('lovely_report_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonResponse({ error: `Failed to read synced reports: ${error.message}` }, 500);
    const batch = (data ?? []) as { lovely_report_id: string }[];
    for (const r of batch) synced.add(r.lovely_report_id);
    if (batch.length < PAGE) break;
  }
  const fresh = reports.filter(r => !synced.has(r.id));
  const skippedExisting = reports.length - fresh.length;
  if (fresh.length === 0) {
    return jsonResponse({ created: 0, skipped_existing: skippedExisting, unresolved_customer: 0, failed: 0 }, 200);
  }

  // Step 3: customer lookups for the fresh reports only.
  let lookups: CustomerLookups;
  try { lookups = await loadLookups(admin, fresh); }
  catch (e) { return jsonResponse({ error: (e as Error).message }, 500); }

  // Step 4: insert one at a time, so a single bad row or a race with an
  // overlapping run costs that report only.
  let created = 0, unresolved = 0, failed = 0, raced = 0;
  for (const report of fresh) {
    const customer = resolveCustomer(report, lookups);
    const serial = normalizeSerial(report.serial_number);
    const { data: ticket, error } = await admin
      .from('service_tickets')
      .insert(reportToTicket(report, customer, !!serial && lookups.knownSerials.has(serial)))
      .select('id, ticket_number, unit_serial')
      .single();

    if (error || !ticket) {
      if (error?.code === UNIQUE_VIOLATION) { raced++; continue; }
      console.error(`sync-lovely-tickets: insert failed for report ${report.id}: ${error?.message}`);
      failed++;
      continue;
    }
    created++;
    if (!customer.customer_id) unresolved++;

    // Audit trail. user_id = null for system-initiated events.
    const { error: logErr } = await admin.from('activity_log').insert({
      user_id: null,
      type: 'lovely_ticket_created',
      entity: ticket.ticket_number,
      detail: `report=${report.id}`,
      entity_type: 'ticket',
      entity_id: ticket.id,
      unit_serial: ticket.unit_serial,
    });
    if (logErr) console.error(`sync-lovely-tickets: activity_log failed for ${ticket.id}: ${logErr.message}`);
  }

  return jsonResponse({
    created,
    skipped_existing: skippedExisting + raced,
    unresolved_customer: unresolved,
    failed,
  }, failed > 0 && created === 0 ? 500 : 200);
}

// Three batched reads: units by serial, app links by Lovely user id, then the
// customers those two point at.
async function loadLookups(admin: SupabaseClient, reports: DamageReport[]): Promise<CustomerLookups> {
  const serials = unique(reports.map(r => normalizeSerial(r.serial_number)))
    .filter(isLookupSafeSerial);
  const userIds = unique(reports.map(r => r.user_id));

  const customerIdBySerial = new Map<string, string>();
  const knownSerials = new Set<string>();
  for (const part of chunks(serials)) {
    const { data, error } = await admin.from('units').select('serial, customer_id').in('serial', part);
    if (error) throw new Error(`Failed to read units: ${error.message}`);
    for (const u of (data ?? []) as { serial: string; customer_id: string | null }[]) {
      const serial = normalizeSerial(u.serial);
      if (!serial) continue;
      knownSerials.add(serial);
      if (u.customer_id) customerIdBySerial.set(serial, u.customer_id);
    }
  }

  const linkByUserId = new Map<string, { customer_id: string | null; email: string | null }>();
  for (const part of chunks(userIds)) {
    const { data, error } = await admin
      .from('customer_app_links').select('lovely_user_id, customer_id, email').in('lovely_user_id', part);
    if (error) throw new Error(`Failed to read customer_app_links: ${error.message}`);
    for (const l of (data ?? []) as { lovely_user_id: string; customer_id: string | null; email: string | null }[]) {
      linkByUserId.set(l.lovely_user_id, { customer_id: l.customer_id, email: l.email });
    }
  }

  const customerIds = unique([
    ...customerIdBySerial.values(),
    ...[...linkByUserId.values()].map(l => l.customer_id),
  ]);
  const customerById = new Map<string, { full_name: string | null; email: string | null }>();
  for (const part of chunks(customerIds)) {
    const { data, error } = await admin.from('customers').select('id, full_name, email').in('id', part);
    if (error) throw new Error(`Failed to read customers: ${error.message}`);
    for (const c of (data ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      customerById.set(c.id, { full_name: c.full_name, email: c.email });
    }
  }

  return { customerIdBySerial, linkByUserId, knownSerials, customerById };
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
