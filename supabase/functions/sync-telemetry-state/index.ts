// Sync telemetry machine states from the LILA telemetry Supabase project
// into the makeLILA unit_telemetry_state table.
//
// Runs every 15 minutes via pg_cron (sync-telemetry-state-15min job).
// Gracefully no-ops when TELEMETRY_SUPABASE_URL / TELEMETRY_SUPABASE_ANON_KEY
// are not set so the function deploys without blocking other pipelines.
//
// Required env vars:
//   SUPABASE_URL                — write target (makeLILA project)
//   SUPABASE_SERVICE_ROLE_KEY   — service role for makeLILA writes
//   TELEMETRY_SUPABASE_URL      — read source (LILA telemetry project)
//   TELEMETRY_SUPABASE_ANON_KEY — anon key for telemetry project reads
//
// Auth: cron-only (X-Cron-Secret header required, matching CRON_SHARED_SECRET).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

// Inline corsHeaders — avoids module-resolution issues at deploy time.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// How many serials to query from telemetry DB in one batch.
const TELEMETRY_BATCH_SIZE = 20;

// ============================================================ Entry point

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
  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const telemetryUrl = Deno.env.get('TELEMETRY_SUPABASE_URL');
  const telemetryKey = Deno.env.get('TELEMETRY_SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  if (_caller.kind !== 'cron') {
    return new Response(
      JSON.stringify({ error: 'This function is cron-only — use the X-Cron-Secret header.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  // Graceful no-op when telemetry credentials are not configured.
  if (!telemetryUrl || !telemetryKey) {
    return jsonResponse({
      skipped: true,
      reason: 'TELEMETRY_SUPABASE_URL or TELEMETRY_SUPABASE_ANON_KEY not configured — inert until secrets are set',
    }, 200);
  }

  const telemetry = createClient(telemetryUrl, telemetryKey);

  // Step 1: Fetch all known unit serials from the telemetry `lila` table.
  const { data: lilaRows, error: lilaErr } = await telemetry
    .from('lila')
    .select('serial_number, status, updated_at')
    .range(0, 9999);

  if (lilaErr) {
    return jsonResponse({ error: `Failed to fetch lila table: ${lilaErr.message}` }, 500);
  }

  const rows = (lilaRows ?? []) as Array<{
    serial_number: string;
    status: string | null;
    updated_at: string | null;
  }>;

  if (rows.length === 0) {
    return jsonResponse({ synced: 0, updated_state: 0, stale_marked: 0 }, 200);
  }

  // Step 2: For each known serial, fetch the most recent machine_health row
  // to get the authoritative current state and timestamp.
  // Batch to avoid hammering the telemetry DB.
  let synced = 0;
  let updatedState = 0;

  for (let i = 0; i < rows.length; i += TELEMETRY_BATCH_SIZE) {
    const batch = rows.slice(i, i + TELEMETRY_BATCH_SIZE);
    await Promise.all(batch.map(async (lila) => {
      const serial = lila.serial_number;
      if (!serial) return;

      // Query machine_health for the most recent row for this serial.
      const { data: healthRows, error: healthErr } = await telemetry
        .from('machine_health')
        .select('state, created_at')
        .eq('serial_number', serial)
        .order('created_at', { ascending: false })
        .limit(1);

      let classifiedState: string;
      let lastSeenAt: string;

      if (healthErr || !healthRows || healthRows.length === 0) {
        // Fall back to the `lila` table's status column if machine_health
        // is empty or unavailable.
        classifiedState = lila.status ?? 'UNKNOWN';
        lastSeenAt = lila.updated_at ?? new Date().toISOString();
      } else {
        const mh = healthRows[0] as { state: string | null; created_at: string | null };
        classifiedState = mh.state ?? lila.status ?? 'UNKNOWN';
        lastSeenAt = mh.created_at ?? lila.updated_at ?? new Date().toISOString();
      }

      // Step 3: Upsert via the SQL helper function so state_held_since is
      // updated atomically (no SELECT-then-UPDATE race window).
      const { error: rpcErr } = await admin.rpc('upsert_telemetry_state', {
        p_unit_serial:          serial,
        p_classified_state:     classifiedState,
        p_machine_last_seen_at: lastSeenAt,
      });

      if (rpcErr) {
        // Skip serials not in the makeLILA units table (FK violation = 23503).
        // Anything else is unexpected but we continue processing other serials.
        if (rpcErr.code !== '23503') {
          console.error(`upsert_telemetry_state failed for ${serial}: ${rpcErr.message}`);
        }
        return;
      }

      synced++;
      // We can't easily distinguish "state changed" vs "state same" from
      // an rpc() call without a second query; count all successful upserts
      // as synced and leave updatedState for the stale-marking step below.
    }));
  }

  // Step 4: Mark any unit_telemetry_state rows stale where
  // last_seen_at is more than 1 hour ago.
  const { data: staleData, error: staleErr } = await admin
    .from('unit_telemetry_state')
    .update({ is_stale: true })
    .lt('last_seen_at', new Date(Date.now() - 3_600_000).toISOString())
    .eq('is_stale', false)
    .select('unit_serial');

  if (staleErr) {
    console.error('Failed to mark stale rows:', staleErr.message);
  }

  const staleMarked = staleData?.length ?? 0;

  return jsonResponse({
    synced,
    updated_state: updatedState,
    stale_marked: staleMarked,
  }, 200);
}

// ============================================================ Response helper

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
