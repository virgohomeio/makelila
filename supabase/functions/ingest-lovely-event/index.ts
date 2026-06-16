// ingest-lovely-event: webhook receiver for events from the lilalovely
// customer app (beta-lovely repo, Supabase project arfdopgbvlfmhmcfghhl).
//
// Auth: shared secret in `X-Lovely-Secret` header matching LOVELY_INGEST_SECRET.
// (Not the standard cron/user authenticate() since the caller is a different
// Supabase project's edge function, not a makelila operator session.)
//
// Resolution chain:
//   1. If `serial_number` present → units.serial → units.customer_id (preferred)
//   2. Else if `email` present → customers.email exact match (case-insensitive)
//   3. Else: insert with customer_id=null, resolution='unresolved'
//
// Side effects:
//   - Upsert customer_app_links (one row per lovely_user_id)
//   - Insert customer_events row with resolved customer_id (may be null)
//
// Spec: docs/integration-lilalovely-2026-06-07.md

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-lovely-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type IngestPayload = {
  event_type: string;
  lovely_user_id: string;
  lovely_email?: string | null;
  serial_number?: string | null;
  occurred_at?: string | null;
  payload?: Record<string, unknown>;
};

type Resolution = 'serial' | 'email' | 'unresolved';

function jsonError(status: number, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...(extra ?? {}) }), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonError(405, 'Use POST');
  }

  // 1. Shared-secret auth.
  const expected = Deno.env.get('LOVELY_INGEST_SECRET');
  if (!expected) {
    return jsonError(500, 'LOVELY_INGEST_SECRET not configured');
  }
  const provided = req.headers.get('x-lovely-secret') ?? '';
  if (provided !== expected) {
    return jsonError(401, 'Bad or missing X-Lovely-Secret');
  }

  // 2. Parse + validate payload.
  let body: IngestPayload;
  try {
    body = await req.json() as IngestPayload;
  } catch {
    return jsonError(400, 'Invalid JSON');
  }
  if (!body.event_type || typeof body.event_type !== 'string') {
    return jsonError(400, 'event_type required (string)');
  }
  if (!body.lovely_user_id || typeof body.lovely_user_id !== 'string') {
    return jsonError(400, 'lovely_user_id required (uuid string)');
  }

  // 3. Resolve customer_id.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let customer_id: string | null = null;
  let resolution: Resolution = 'unresolved';

  // 3a. Serial → unit → customer.
  if (body.serial_number) {
    const { data: unit } = await admin
      .from('units')
      .select('customer_id')
      .eq('serial', body.serial_number)
      .maybeSingle();
    if (unit?.customer_id) {
      customer_id = unit.customer_id as string;
      resolution = 'serial';
    }
  }

  // 3b. Email fallback (only if serial didn't resolve).
  if (!customer_id && body.lovely_email) {
    const { data: customer } = await admin
      .from('customers')
      .select('id')
      .ilike('email', body.lovely_email)
      .maybeSingle();
    if (customer?.id) {
      customer_id = customer.id as string;
      resolution = 'email';
    }
  }

  // 4. Upsert customer_app_links (lazy link create / last-seen bump).
  const linkRow = {
    lovely_user_id: body.lovely_user_id,
    customer_id,
    email: body.lovely_email ?? null,
    last_seen_at: new Date().toISOString(),
    resolution,
  };
  const { error: linkErr } = await admin
    .from('customer_app_links')
    .upsert(linkRow, {
      onConflict: 'lovely_user_id',
      // Don't bump first_seen_at on conflict; let the DB default keep it.
      ignoreDuplicates: false,
    });
  if (linkErr) {
    return jsonError(500, `Link upsert failed: ${linkErr.message}`);
  }

  // 5. Insert event.
  const eventRow = {
    customer_id,
    lovely_user_id: body.lovely_user_id,
    event_type: body.event_type,
    event_payload: body.payload ?? {},
    source: 'lovely' as const,
    occurred_at: body.occurred_at ?? new Date().toISOString(),
    raw_payload: body as unknown as Record<string, unknown>,
  };
  const { error: evErr } = await admin
    .from('customer_events')
    .insert(eventRow);
  if (evErr) {
    return jsonError(500, `Event insert failed: ${evErr.message}`);
  }

  return jsonOk({
    ok: true,
    resolution,
    customer_id,
    event_type: body.event_type,
  });
});
